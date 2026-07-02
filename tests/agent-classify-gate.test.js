import assert from 'node:assert/strict';
import { isClassifierApproved } from '../scripts/agent/classify.mjs';

// This test LOCKS the classifier gate's quality floor. Owner policy (2026-06,
// tightened 2026-07-02 after the precision audit): the repair may be carried
// out by ANOTHER user (helper/mechanic), but the OUTCOME CONFIRMATION must come
// from the owner (the same user who reported the fault) — that requirement now
// lives inside the has_confirmed_resolution DEFINITION in the prompt. So
// same_user_confirms_resolution is NOT gated on separately — but
// has_confirmed_resolution (a confirmed successful repair exists) IS still
// required, in lockstep with the extractor + validate (fault-anchor) + verify gates.
// If a future edit re-adds same_user_confirms_resolution to the gate, or drops
// has_confirmed_resolution, this test must fail so the change is caught in review.

const fullyApproved = {
  should_seed: true,
  is_relevant: true,
  has_explicit_fault: true,
  has_confirmed_resolution: true,
  same_user_confirms_resolution: true,
  evidence_post_numbers: [1, 3],
};
assert.equal(isClassifierApproved(fullyApproved), true, 'all gates true → approved');

// Each of these gates is still required.
const requiredFlags = [
  'should_seed',
  'is_relevant',
  'has_explicit_fault',
  'has_confirmed_resolution',
];
for (const flag of requiredFlags) {
  const r = { ...fullyApproved, [flag]: false };
  assert.equal(isClassifierApproved(r), false, `${flag}=false → rejected`);
}

// Owner policy: same_user_confirms_resolution is INFORMATIONAL ONLY and no longer
// gates. A fault described by the owner with a CONFIRMED fix posted/confirmed by a
// helper (different author) must now PASS — as long as has_confirmed_resolution holds.
assert.equal(
  isClassifierApproved({ ...fullyApproved, same_user_confirms_resolution: false }),
  true,
  'helper-confirmed fix (different author) now passes when the fix is confirmed',
);
// But an UNCONFIRMED fix is still rejected (the confirmation requirement stays).
assert.equal(
  isClassifierApproved({ ...fullyApproved, same_user_confirms_resolution: false, has_confirmed_resolution: false }),
  false,
  'different author AND no confirmed repair → still rejected',
);

// Evidence posts are mandatory.
assert.equal(isClassifierApproved({ ...fullyApproved, evidence_post_numbers: [] }), false, 'no evidence → rejected');
assert.equal(isClassifierApproved({ ...fullyApproved, evidence_post_numbers: undefined }), false, 'missing evidence → rejected');

// Null / malformed input defaults to rejection.
assert.equal(isClassifierApproved(null), false, 'null → rejected');
assert.equal(isClassifierApproved({}), false, 'empty → rejected');

console.log('agent-classify-gate.test.js passed');
