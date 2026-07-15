/**
 * llm.mjs — Central LLM router for the crawl agent.
 *
 * Every AI call in the pipeline goes through runLlm(task, prompt, options).
 * Which provider+model serves a task is decided here:
 *
 *   task        default route        rationale
 *   ─────────   ──────────────────   ─────────────────────────────────────────
 *   classify    claude:haiku         high volume → cheapest subscription model
 *   extract     claude:sonnet        ~18% of threads, quality matters
 *   verify      deepseek:deepseek-v4-flash tiny volume; independent second AI
 *                                       (different vendor than the extractor)
 *   calibrate   claude:sonnet        rare, needs good HTML reasoning
 *   diary       claude:haiku         short free-form summaries
 *
 * Override per task via env: AGENT_LLM_CLASSIFY=deepseek:deepseek-v4-flash etc.
 * Provider 'claude' uses the Claude Code CLI (subscription login, no API key).
 * Provider 'deepseek' uses the HTTP API (needs DEEPSEEK_API_KEY).
 */

import { runClaudePrompt } from './claude-cli.mjs';
import { assertDeepSeekNotQuotaError } from './quota.mjs';
import { OFFLINE_DEEPSEEK_MODEL, DEEPSEEK_CHAT_URL } from './deepseek.mjs';

const DEFAULT_ROUTES = {
  // 2026-07-15: classify moved off Claude (was claude:haiku) onto DeepSeek to free the Claude
  // subscription for the strong-model decision pass (review-queue-decide.mjs). Classify is a coarse
  // "does this thread hold ≥1 resolved case" gate — an A/B on 14 real threads showed DeepSeek ≈
  // haiku (11/14 agree, 10 vs 11 approved), so yield is preserved. Runs in the 17:00–24:00 crawl
  // window = DeepSeek off-peak. (The nuanced per-case APPROVE/REJECT judgment stays on Claude —
  // DeepSeek was far too strict there.)
  classify: `deepseek:${OFFLINE_DEEPSEEK_MODEL}`,
  extract: 'claude:sonnet',
  dedupe: 'claude:haiku', // cluster same-thread duplicate cases (dedup-thread-cases.mjs); low volume, small prompt
  verify: `deepseek:${OFFLINE_DEEPSEEK_MODEL}`,
  calibrate: 'claude:sonnet',
  diary: 'claude:haiku',
  discover: 'claude:sonnet', // forum discovery needs web search + judgment
  'taxonomy-seed': 'claude:sonnet', // one-shot fault-taxonomy proposal (fault-taxonomy.mjs)
  'taxonomy-classify': 'claude:haiku', // high-volume case→taxonomy backfill
  'catalog-propose': 'claude:sonnet', // draft accurate catalog entries for missing models (vehicle-catalog-proposals.mjs)
  'catalog-verify': 'claude:sonnet', // Claude+WebSearch multi-source verification of a candidate vehicle (vehicle-web-verify.mjs)
  translate: 'claude:haiku', // high-volume resolution cs/de backfill (backfill-resolution-i18n.mjs)
};

/**
 * Resolve a task name to { provider, model }.
 * Env override: AGENT_LLM_<TASK>=provider:model (e.g. AGENT_LLM_VERIFY=claude:opus)
 */
export function resolveRoute(task, env = process.env) {
  const override = env[`AGENT_LLM_${task.toUpperCase()}`];
  const raw = (override || DEFAULT_ROUTES[task] || '').trim();
  if (!raw) throw new Error(`Unknown LLM task: ${task}`);

  const sep = raw.indexOf(':');
  const provider = (sep === -1 ? raw : raw.slice(0, sep)).toLowerCase();
  const model = sep === -1 ? null : raw.slice(sep + 1);

  if (provider !== 'claude' && provider !== 'deepseek') {
    throw new Error(`Unknown LLM provider "${provider}" for task ${task} (use claude:<model> or deepseek:<model>)`);
  }
  // The model string is interpolated into a PowerShell command on Windows;
  // restrict it to a safe alphabet so an env override cannot inject shell
  // syntax (incl. Unicode smart quotes that PS treats as string delimiters).
  if (model !== null && !/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new Error(`Invalid model "${model}" for task ${task}: only letters, digits, dot, underscore and hyphen are allowed`);
  }
  return { provider, model };
}

/**
 * Run one prompt through the routed provider for a task.
 *
 * @param {string} task - classify | extract | verify | calibrate | diary
 * @param {string} prompt
 * @param {object} [options]
 * @param {number} [options.maxTokens] - output cap (DeepSeek only; the CLI has no flag)
 * @param {number} [options.temperature] - DeepSeek only
 * @param {number} [options.timeoutMs] - hard timeout per call (both providers)
 * @param {string[]} [options.allowedTools] - CLI tools to allow (claude only), e.g. ['WebSearch']
 * @param {string} [options.apiKey] - DeepSeek key override (default env DEEPSEEK_API_KEY)
 * @returns {Promise<string>} the model's text output
 * @throws {QuotaError} when the provider's quota/usage limit is exhausted
 */
export async function runLlm(task, prompt, options = {}) {
  const { provider, model } = resolveRoute(task);

  if (provider === 'claude') {
    const { text } = await runClaudePrompt(prompt, {
      model: model || 'sonnet',
      timeoutMs: options.timeoutMs,
      allowedTools: options.allowedTools,
    });
    return text;
  }
  if (options.allowedTools?.length) {
    throw new Error(`allowedTools (web search) requires a claude provider, but task "${task}" is routed to ${provider}`);
  }

  const apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(`DEEPSEEK_API_KEY not set (task "${task}" is routed to DeepSeek)`);
  }
  return deepseekChat({
    apiKey,
    model: model || OFFLINE_DEEPSEEK_MODEL,
    prompt,
    maxTokens: options.maxTokens ?? 2000,
    temperature: options.temperature ?? 0.2,
    timeoutMs: options.timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// DeepSeek HTTP API (shared; formerly duplicated in classify.mjs/extract.mjs)
// ---------------------------------------------------------------------------

export async function deepseekChat({ apiKey, model = OFFLINE_DEEPSEEK_MODEL, prompt, maxTokens, temperature = 0.2, timeoutMs = 120_000, thinking = { type: 'disabled' } }) {
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(DEEPSEEK_CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          messages: [{ role: 'user', content: prompt }],
          // v4-flash: vypnout uvažovací režim (rychlý strukturovaný JSON; thinking je top-level pole)
          ...(thinking ? { thinking } : {}),
        }),
        // Hard per-attempt timeout — a stalled connection must not hang the
        // whole agent (it would hold the scheduler mutex forever)
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      if (isTimeout && attempt < maxRetries) {
        // Back off before retrying so a persistently slow endpoint cannot tie
        // up the run (and the scheduler mutex) for maxRetries × timeoutMs
        const wait = Math.min(2000 * Math.pow(2, attempt), 30_000);
        console.log(`  DeepSeek timeout after ${timeoutMs}ms, retry in ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw isTimeout ? new Error(`DeepSeek timeout after ${timeoutMs}ms`) : err;
    }

    if (res.ok) {
      const data = await res.json();
      return (data?.choices?.[0]?.message?.content ?? '').toString().trim();
    }

    const body = await res.text().catch(() => '');

    // Quota/billing exhaustion is permanent, not transient — check before retry
    assertDeepSeekNotQuotaError(res.status, body);

    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      const wait = Math.min(2000 * Math.pow(2, attempt), 30_000);
      console.log(`  DeepSeek ${res.status}, retry in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    throw new Error(`DeepSeek API error (${res.status}): ${body.slice(0, 300)}`);
  }
}
