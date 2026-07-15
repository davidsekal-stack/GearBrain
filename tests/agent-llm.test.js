import assert from 'node:assert/strict';
import { resolveRoute, deepseekChat, runLlm } from '../scripts/agent/llm.mjs';
import {
  isClaudeLimitMessage,
  parseClaudeResetAt,
  QuotaError,
  formatQuotaMessage,
  assertDeepSeekNotQuotaError,
} from '../scripts/agent/quota.mjs';

function testDefaultRoutes() {
  assert.deepEqual(resolveRoute('classify', {}), { provider: 'claude', model: 'haiku' });
  assert.deepEqual(resolveRoute('extract', {}), { provider: 'claude', model: 'sonnet' });
  assert.deepEqual(resolveRoute('verify', {}), { provider: 'deepseek', model: 'deepseek-v4-flash' });
  assert.deepEqual(resolveRoute('calibrate', {}), { provider: 'claude', model: 'sonnet' });
  assert.deepEqual(resolveRoute('diary', {}), { provider: 'claude', model: 'haiku' });
  assert.deepEqual(resolveRoute('discover', {}), { provider: 'claude', model: 'sonnet' });
}

async function testAllowedToolsRequiresClaude() {
  // Web search routed to DeepSeek must be rejected, not silently dropped
  await assert.rejects(
    runLlm('verify', 'p', { allowedTools: ['WebSearch'], apiKey: 'k' }),
    /requires a claude provider/,
  );
}

function testEnvOverrides() {
  const env = { AGENT_LLM_VERIFY: 'claude:opus', AGENT_LLM_CLASSIFY: 'deepseek:deepseek-v4-flash' };
  assert.deepEqual(resolveRoute('verify', env), { provider: 'claude', model: 'opus' });
  assert.deepEqual(resolveRoute('classify', env), { provider: 'deepseek', model: 'deepseek-v4-flash' });
  // Provider without model → model null (provider default applies later)
  assert.deepEqual(resolveRoute('diary', { AGENT_LLM_DIARY: 'claude' }), { provider: 'claude', model: null });
}

function testInvalidRoutes() {
  assert.throws(() => resolveRoute('nonexistent-task', {}), /Unknown LLM task/);
  assert.throws(() => resolveRoute('verify', { AGENT_LLM_VERIFY: 'openai:gpt' }), /Unknown LLM provider/);
}

function testModelValidation() {
  // Legitimate model names pass
  assert.deepEqual(resolveRoute('extract', { AGENT_LLM_EXTRACT: 'claude:claude-opus-4-8' }),
    { provider: 'claude', model: 'claude-opus-4-8' });
  // Shell-injection via PowerShell smart quotes must be rejected, not interpolated
  assert.throws(() => resolveRoute('classify', { AGENT_LLM_CLASSIFY: "claude:haiku’; rm x" }), /Invalid model/);
  assert.throws(() => resolveRoute('classify', { AGENT_LLM_CLASSIFY: "claude:haiku'; whoami" }), /Invalid model/);
  assert.throws(() => resolveRoute('classify', { AGENT_LLM_CLASSIFY: 'claude:haiku spaces' }), /Invalid model/);
}

function testDeepSeekQuotaDetection() {
  // 402/403 are quota statuses regardless of body
  assert.throws(() => assertDeepSeekNotQuotaError(402, '{}'), QuotaError);
  assert.throws(() => assertDeepSeekNotQuotaError(403, 'forbidden'), QuotaError);
  // Body-pattern detection on other 4xx
  assert.throws(() => assertDeepSeekNotQuotaError(400, 'Insufficient Balance'), QuotaError);
  // Plain transient errors are NOT quota
  assert.doesNotThrow(() => assertDeepSeekNotQuotaError(429, 'rate limited, slow down'));
  assert.doesNotThrow(() => assertDeepSeekNotQuotaError(500, 'internal error'));
  assert.doesNotThrow(() => assertDeepSeekNotQuotaError(200, 'ok'));
}

async function testDeepseekChatWithStub() {
  const realFetch = globalThis.fetch;
  try {
    // 402 → QuotaError before any retry
    globalThis.fetch = async () => ({ ok: false, status: 402, text: async () => 'Insufficient Balance' });
    await assert.rejects(
      deepseekChat({ apiKey: 'k', prompt: 'p', maxTokens: 10 }),
      QuotaError,
    );

    // 429 then 200 → retry then success
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, text: async () => 'rate limited' };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'hello' } }] }) };
    };
    const out = await deepseekChat({ apiKey: 'k', prompt: 'p', maxTokens: 10 });
    assert.equal(out, 'hello');
    assert.equal(calls, 2);

    // Timeout (AbortError) is retried then surfaced as a DeepSeek timeout error
    globalThis.fetch = async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; };
    await assert.rejects(
      deepseekChat({ apiKey: 'k', prompt: 'p', maxTokens: 10, timeoutMs: 10 }),
      /DeepSeek timeout/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

function testLimitMessageDetection() {
  assert.equal(isClaudeLimitMessage("You've reached your usage limit. Your limit will reset at 10pm."), true);
  assert.equal(isClaudeLimitMessage('Claude AI usage limit reached|1735689600'), true);
  assert.equal(isClaudeLimitMessage('5-hour limit reached'), true);
  assert.equal(isClaudeLimitMessage('Failed to authenticate. API Error: 401'), false);
  assert.equal(isClaudeLimitMessage('Invalid model name'), false);
}

function testResetTimeParsing() {
  const now = new Date('2026-06-10T14:00:00');

  // Epoch (seconds)
  const epoch = Math.floor(new Date('2026-06-10T20:00:00').getTime() / 1000);
  const fromEpoch = parseClaudeResetAt(`usage limit reached|${epoch}`, now);
  assert.equal(fromEpoch?.getTime(), epoch * 1000);

  // Epoch in the past → rejected
  assert.equal(parseClaudeResetAt('usage limit reached|946684800', now), null);

  // Clock time later today
  const pm = parseClaudeResetAt('Your limit will reset at 10pm.', now);
  assert.equal(pm?.getHours(), 22);
  assert.equal(pm?.getDate(), now.getDate());

  // Clock time already past today → tomorrow
  const am = parseClaudeResetAt('Your limit will reset at 9am.', now);
  assert.equal(am?.getHours(), 9);
  assert.equal(am > now, true);

  // 24h format with minutes
  const hm = parseClaudeResetAt('resets at 16:30', now);
  assert.equal(hm?.getHours(), 16);
  assert.equal(hm?.getMinutes(), 30);

  // Nothing parseable
  assert.equal(parseClaudeResetAt('You have hit your usage limit.', now), null);
}

function testQuotaErrorShape() {
  const reset = new Date(Date.now() + 3600_000);
  const err = new QuotaError('Claude', 'usage limit reached', { resetAt: reset });
  assert.equal(err.service, 'Claude');
  assert.equal(err.resetAt, reset);
  assert.match(err.message, /Claude quota exhausted/);

  // resetAt optional / invalid dates normalized to null
  assert.equal(new QuotaError('DeepSeek', 'x').resetAt, null);
  assert.equal(new QuotaError('Claude', 'x', { resetAt: new Date('invalid') }).resetAt, null);

  // Console message mentions automatic resume
  const msg = formatQuotaMessage(err, reset);
  assert.match(msg, /resume automatically/);
  assert.match(msg, new RegExp(reset.toISOString().slice(0, 10)));
}

testDefaultRoutes();
testEnvOverrides();
testInvalidRoutes();
testModelValidation();
testDeepSeekQuotaDetection();
testLimitMessageDetection();
testResetTimeParsing();
testQuotaErrorShape();
await testDeepseekChatWithStub();
await testAllowedToolsRequiresClaude();

console.log('agent-llm.test.js passed');
