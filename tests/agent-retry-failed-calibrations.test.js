import assert from 'node:assert/strict';
import { planCalibrationRetry } from '../scripts/agent/retry-failed-calibrations.mjs';

// Profiles: only example.com has a hand-written profile.
const profiles = [{ match: 'example.com', engine: 'phpbb', sections: ['https://example.com/f'], calibration: {} }];

const forums = [
  // failed WITH a matching profile → apply profile directly (cohort 1)
  { id: 'p1', url: 'https://example.com/forum', name: 'Profiled', status: 'calibration_failed', created_at: '2026-01-01' },
  // failed WITHOUT a profile, never retried → eligible to re-arm (cohort 2)
  { id: 'r1', url: 'https://noprofile-a.com/', name: 'NoProfA', status: 'calibration_failed', created_at: '2026-02-01' },
  { id: 'r2', url: 'https://noprofile-b.com/', name: 'NoProfB', status: 'calibration_failed', created_at: '2026-03-01' },
  { id: 'r3', url: 'https://noprofile-c.com/', name: 'NoProfC', status: 'calibration_failed', created_at: '2026-04-01' },
  { id: 'r4', url: 'https://noprofile-d.com/', name: 'NoProfD', status: 'calibration_failed', created_at: '2026-05-01' },
  // healthy forum → never touched
  { id: 'ok', url: 'https://healthy.com/', name: 'OK', status: 'active', calibration_status: 'calibrated', created_at: '2026-01-01' },
];

// Retry state: r1 retried once 10 days ago (backoff 60d → still waiting);
// r2 retried once 70 days ago (backoff 60d elapsed → eligible again).
const retryState = {
  r1: { n: 1, last: '2026-06-22' },
  r2: { n: 1, last: '2026-04-23' },
};
const today = '2026-07-02';

const plan = planCalibrationRetry({ forums, profiles, retryState, today, opts: { maxPerRun: 2, afterDays: 30, capDays: 180 } });

// Cohort 1: profiled failed forum applied directly.
assert.equal(plan.applyProfile.length, 1, 'one profiled failed forum');
assert.equal(plan.applyProfile[0].forum.id, 'p1');

// r1 is in backoff (10d < 60d) → skipped; r3, r4 never retried → eligible; r2 elapsed → eligible.
const rearmIds = plan.rearm.map(r => r.forum.id);
assert.equal(plan.rearm.length, 2, 'capped at maxPerRun=2');
// oldest-created eligible first: r2 (Feb? no created 2026-03), r3 (Apr), r4 (May) + r2 (Mar). Eligible set = {r2,r3,r4}; oldest created = r2(2026-03) then r3(2026-04).
assert.deepEqual(rearmIds, ['r2', 'r3'], 'oldest-created eligible re-armed first, capped');
assert.ok(plan.skipped.some(s => s.forum.id === 'r1'), 'r1 still in backoff → skipped');
assert.equal(plan.deferred.length, 1, 'r4 eligible but over the per-run cap → deferred');
assert.equal(plan.deferred[0].forum.id, 'r4');

// Healthy forum is never selected.
assert.ok(![...rearmIds, ...plan.applyProfile.map(a => a.forum.id)].includes('ok'), 'healthy forum untouched');

// No profiles + no retry state: all failed forums are eligible (bounded by cap).
const fresh = planCalibrationRetry({ forums, profiles: [], retryState: {}, today, opts: { maxPerRun: 10, afterDays: 30 } });
assert.equal(fresh.applyProfile.length, 0, 'no profiles → nothing applied by profile');
assert.equal(fresh.rearm.length, 5, 'all 5 failed forums re-armed (p1 has no profile now either)');

console.log('agent-retry-failed-calibrations.test.js passed');
