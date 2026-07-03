import assert from 'node:assert/strict';

// verify.mjs → runLlm('verify') → deepseekChat → fetch. We stub globalThis.fetch
// (same approach as agent-llm.test.js) and ensure a key is present so runLlm's
// DeepSeek branch proceeds.
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';

const {
  verifyCase,
  buildPrompt,
  parseStructuredVerdict,
  isLikelyOutOfScopeVehicle,
  VERIFIER_CONDITIONS,
} = await import('../scripts/agent/verify.mjs');

const ALL_TRUE = {
  in_scope: true, vehicle_matches_cited_posts: true, is_genuine_fault: true,
  repair_performed: true, repair_confirmed: true, actionable: true,
  reasons: { in_scope: '', vehicle_matches_cited_posts: '', is_genuine_fault: '', repair_performed: '', repair_confirmed: '', actionable: '' },
};
const withFalse = (cond, why) => ({ ...ALL_TRUE, [cond]: false, reasons: { ...ALL_TRUE.reasons, [cond]: why } });

// Returns a fetch stub that yields the given contents on successive calls.
function stubFetch(contents) {
  let i = 0;
  const calls = { n: 0 };
  globalThis.fetch = async () => {
    calls.n++;
    const content = contents[Math.min(i++, contents.length - 1)];
    if (content instanceof Error) throw content;
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return calls;
}

// ── parseStructuredVerdict ──────────────────────────────────────────────────
function testParse() {
  assert.equal(parseStructuredVerdict(JSON.stringify(ALL_TRUE)).verdict, 'PASS', 'all true → PASS');

  const f = parseStructuredVerdict(JSON.stringify(withFalse('is_genuine_fault', 'config menu question')));
  assert.equal(f.verdict, 'FAIL');
  assert.match(f.reason, /is_genuine_fault/, 'reason names the failing condition');
  assert.match(f.reason, /config menu question/, 'reason carries the model explanation');

  // first false condition (by VERIFIER_CONDITIONS order) is the one reported
  const two = { ...ALL_TRUE, vehicle_matches_cited_posts: false, is_genuine_fault: false,
    reasons: { ...ALL_TRUE.reasons, vehicle_matches_cited_posts: 'A6 vs cited A4', is_genuine_fault: 'x' } };
  assert.match(parseStructuredVerdict(JSON.stringify(two)).reason, /vehicle_matches_cited_posts/);

  // prose around the JSON is tolerated (indexOf/lastIndexOf slice)
  assert.equal(parseStructuredVerdict('Sure!\n```json\n' + JSON.stringify(ALL_TRUE) + '\n```').verdict, 'PASS');

  // fail-closed cases
  assert.ok(parseStructuredVerdict('not json at all').parseFail, 'garbage → parseFail');
  assert.ok(parseStructuredVerdict('{}').parseFail, 'empty object (missing keys) → parseFail');
  const missing = { ...ALL_TRUE }; delete missing.actionable;
  assert.ok(parseStructuredVerdict(JSON.stringify(missing)).parseFail, 'missing key → parseFail');
  const nonBool = { ...ALL_TRUE, repair_confirmed: 'yes' };
  assert.ok(parseStructuredVerdict(JSON.stringify(nonBool)).parseFail, 'non-boolean → parseFail');

  assert.deepEqual(VERIFIER_CONDITIONS.length, 6);
}

// ── isLikelyOutOfScopeVehicle (deterministic pre-gate) ──────────────────────
function testPreGate() {
  // Motorcycles on moto-capable makers → out of scope
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'BMW', model_raw: 'R1150R' }), true, 'BMW R1150R = moto');
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'BMW', model_raw: 'R 1200 GS' }), true);
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'Suzuki', model_raw: 'GSX-R1000' }), true);
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'Kawasaki', model_raw: 'Ninja ZX-6R' }), true);
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'Honda', model_raw: 'CBR600' }), true);

  // Generic non-car words anywhere → out of scope
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'Generic', model_raw: 'scooter 125' }), true);
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'X', model_raw: 'tractor' }), true);

  // Passenger cars / vans must NOT trip — including the false-positive traps
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'BMW', model_raw: '320d' }), false, 'BMW car');
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'BMW', model_raw: 'E39' }), false);
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'BMW', model_raw: 'X3 E83' }), false);
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'Ford', model_raw: 'Transit Mk6' }), false, 'van in scope');
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'Toyota', model_raw: 'Proace City' }), false, 'van in scope');
  // displacement must NEVER trigger the moto-code regex (it runs on model only)
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'Volkswagen', model_raw: 'Golf', engine_raw: '1800cc 1.8' }), false);
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'Opel', model_raw: 'Astra K', engine_raw: '1598cc' }), false);
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'Mercedes-Benz', model_raw: 'C230K', engine_raw: '2.3 Kompressor' }), false);
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'Renault', model_raw: 'R19' }), false, 'classic car R-number ≠ moto');
  assert.equal(isLikelyOutOfScopeVehicle({}), false, 'empty → not out of scope');

  // Light pickups are IN scope (owner policy) — must NOT trip the pre-gate.
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'Toyota', model_raw: 'Hilux' }), false, 'light pickup in scope');
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'Toyota', model_raw: 'Tacoma' }), false, 'light pickup in scope');
  assert.equal(isLikelyOutOfScopeVehicle({ brand_raw: 'Ford', model_raw: 'Ranger 2.0 TDCi' }), false, 'light pickup in scope');
}

// ── buildPrompt injects the anchors ─────────────────────────────────────────
function testPromptAnchors() {
  const prompt = buildPrompt('POST 1 | author: bob:\nhi', {
    brand_raw: 'Škoda', model_raw: 'Fabia', engine_raw: '1.2 HTP',
    case_author: 'bob', fault_post_numbers: [1, 3], resolution_post_numbers: [8],
    symptoms: ['no start'], obd_codes: [], description: 'd', resolution: 'r',
  });
  assert.match(prompt, /CASE AUTHOR: bob/);
  assert.match(prompt, /FAULT POSTS: 1, 3/);
  assert.match(prompt, /RESOLUTION POSTS: 8/);
  assert.match(prompt, /Škoda Fabia 1\.2 HTP/);
  assert.match(prompt, /in_scope/);
  assert.match(prompt, /vehicle_matches_cited_posts/);
  // Owner policy is baked into the prompt: pickups in scope + repair-by-anyone.
  assert.match(prompt, /light pickup/i, 'light pickups declared in scope');
  assert.match(prompt, /does not matter who carried it out/i, 'single-author requirement relaxed');
  assert.match(prompt, /resolution may be provided or carried out by another user/i, 'resolution may come from a helper');
  // Anti-injection: the thread block is framed as untrusted data, not instructions.
  assert.match(prompt, /untrusted forum content|NOT instructions/i, 'thread is flagged untrusted (prompt-injection hardening)');
}

// ── verifyCase end-to-end with stubbed DeepSeek ─────────────────────────────
async function testVerifyCase() {
  const realFetch = globalThis.fetch;
  const car = { brand_raw: 'Audi', model_raw: 'A3', case_author: 'x', fault_post_numbers: [1], resolution_post_numbers: [2], symptoms: ['s'], description: 'd', resolution: 'r' };
  try {
    // all-true → PASS
    stubFetch([JSON.stringify(ALL_TRUE)]);
    assert.equal((await verifyCase('thread', car)).verdict, 'PASS');

    // one-false → FAIL naming the condition
    stubFetch([JSON.stringify(withFalse('repair_performed', 'fixed itself'))]);
    const r = await verifyCase('thread', car);
    assert.equal(r.verdict, 'FAIL');
    assert.match(r.reason, /repair_performed/);

    // pre-gate motorcycle short-circuits to FAIL with NO LLM call
    let called = false;
    globalThis.fetch = async () => { called = true; throw new Error('should not be called'); };
    const moto = await verifyCase('thread', { brand_raw: 'BMW', model_raw: 'R1150R', case_author: 'x', fault_post_numbers: [1], resolution_post_numbers: [1], symptoms: ['s'], description: 'd', resolution: 'r' });
    assert.equal(moto.verdict, 'FAIL');
    assert.match(moto.reason, /Pre-gate/);
    assert.equal(called, false, 'pre-gate must not spend a DeepSeek call');

    // parse-fail then valid on retry → PASS (2 calls)
    const c1 = stubFetch(['garbage no json', JSON.stringify(ALL_TRUE)]);
    assert.equal((await verifyCase('thread', car)).verdict, 'PASS');
    assert.equal(c1.n, 2, 'one retry happened');

    // parse-fail twice → fail-closed
    const c2 = stubFetch(['nope', 'still nope']);
    const fc = await verifyCase('thread', car);
    assert.equal(fc.verdict, 'FAIL');
    assert.match(fc.reason, /not valid JSON/);
    assert.equal(c2.n, 2, 'one retry then give up');
  } finally {
    globalThis.fetch = realFetch;
  }
}

testParse();
testPreGate();
testPromptAnchors();
await testVerifyCase();

console.log('agent-verify.test.js passed');
