import assert from 'node:assert/strict';

// The module imports triage.mjs (for verifyQuotes), which needs these env defaults present so
// its LLM router import is inert; no LLM call is made by merely importing the parsers below.
process.env.SUPABASE_SERVICE_KEY ||= 'test-key-not-used';

const { parseVerdict, parseRefute } = await import('../scripts/agent/review-queue-decide.mjs');

function testParseVerdict() {
  const ok = parseVerdict('{"verdict":"approve","confidence":"high","failed_clause":"none","reason_code":"none","reason_cs":"ok","quotes":[]}');
  assert.equal(ok.verdict, 'approve');
  assert.equal(ok.confidence, 'high');

  const rej = parseVerdict('noise before {"verdict":"reject","confidence":"bogus","failed_clause":"d","reason_code":"unconfirmed","reason_cs":"x"} trailing');
  assert.equal(rej.verdict, 'reject');
  assert.equal(rej.confidence, 'low', 'invalid confidence -> low');
  assert.equal(rej.failedClause, 'd');
  assert.equal(rej.reasonCode, 'unconfirmed');

  // A reject with a bogus reason_code falls back to 'other' (never an invalid app code).
  const rej2 = parseVerdict('{"verdict":"reject","reason_code":"nonsense"}');
  assert.equal(rej2.reasonCode, 'other');

  assert.equal(parseVerdict('not json at all').parseFail, true, 'garbage -> parseFail');
  assert.equal(parseVerdict('{"verdict":"maybe"}').parseFail, true, 'unknown verdict -> parseFail');
}

function testParseRefute() {
  const up = parseRefute('{"refuted":false,"confidence":"high","failed_clause":"none","reason_code":"none","reason_cs":"drží","quote":{"post":"5","text":"funguje"}}');
  assert.equal(up.refuted, false);
  assert.equal(up.confidence, 'high');
  assert.ok(up.quote && up.quote.text === 'funguje');

  const ref = parseRefute('{"refuted":true,"failed_clause":"d","reason_code":"unconfirmed","reason_cs":"majitel nepotvrdil"}');
  assert.equal(ref.refuted, true);
  assert.equal(ref.failedClause, 'd');
  assert.equal(ref.reasonCode, 'unconfirmed');
  assert.equal(ref.quote, null, 'missing quote -> null');

  // FAIL-SAFE: a non-boolean "refuted" or unparseable output must be parseFail so the caller
  // treats the double-check as failed (rejects, never auto-approves on an unreadable skeptic).
  assert.equal(parseRefute('{"refuted":"yes"}').parseFail, true, 'non-boolean refuted -> parseFail');
  assert.equal(parseRefute('garbage').parseFail, true, 'garbage -> parseFail');

  // A bogus reason_code on a refute defaults to a valid app code (unconfirmed), never invalid.
  const ref2 = parseRefute('{"refuted":true,"reason_code":"nope"}');
  assert.equal(ref2.reasonCode, 'unconfirmed');
}

testParseVerdict();
testParseRefute();

console.log('agent-review-queue-decide.test.js passed');
