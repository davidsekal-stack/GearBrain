import assert from 'node:assert/strict';
import { computeFailureStreak } from '../scripts/agent/orchestrator.mjs';

// No progress AND a fetch failure → streak grows (blocked-forum signature).
assert.equal(computeFailureStreak(0, false, true), 1, 'first no-progress+error batch');
assert.equal(computeFailureStreak(2, false, true), 3, 'streak accumulates');

// Any progress resets the streak, even if there were also some errors.
assert.equal(computeFailureStreak(5, true, true), 0, 'progress resets even with errors');
assert.equal(computeFailureStreak(5, true, false), 0, 'clean progress resets');

// No failure and no progress (e.g. an empty but SUCCESSFUL head-scan) must NOT
// count as a failure — the whole point is not to park a working, drained forum.
assert.equal(computeFailureStreak(2, false, false), 0, 'empty successful batch is not a failure');

// Robust to a null/undefined prior counter.
assert.equal(computeFailureStreak(null, false, true), 1, 'null prior treated as 0');
assert.equal(computeFailureStreak(undefined, false, true), 1, 'undefined prior treated as 0');

console.log('agent-forum-breaker.test.js passed');
