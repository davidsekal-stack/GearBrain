import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentState } from '../scripts/agent/state.mjs';

const dir = mkdtempSync(join(tmpdir(), 'agent-state-test-'));
const dbPath = join(dir, 'agent.db');

try {
  let state = new AgentState(dbPath);

  const forumId = state.addForum({ url: 'https://example.com/forum' });
  state.updateForum(forumId, {
    status: 'exhausted',
    calibration_status: 'calibrated',
    cooldown_until: '2000-01-01T00:00:00.000Z',
  });

  const threadId = state.addThread({
    forumId,
    url: 'https://example.com/viewtopic.php?f=1&t=100&sid=session123',
  });

  const thread = state.getThread(threadId);
  assert.equal(thread.url, 'https://example.com/viewtopic.php?f=1&t=100');
  assert.equal(
    state.getThreadByUrl('https://example.com/viewtopic.php?f=1&t=100')?.id,
    threadId
  );

  const readyForums = state.getForumsToProcess(10);
  assert.equal(readyForums.some(f => f.id === forumId), true);
  assert.equal(state.getForumsPendingCalibration(10).some(f => f.id === forumId), false);

  const pendingForumId = state.addForum({ url: 'https://pending.example.com/forum' });
  const pendingForums = state.getForumsPendingCalibration(10);
  assert.equal(pendingForums.some(f => f.id === pendingForumId), true);

  state.close();

  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec('PRAGMA foreign_keys=ON');
  legacyDb.prepare(
    `INSERT INTO threads (id, forum_id, url, title, status, thread_text)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    'legacy-thread-a',
    forumId,
    'https://example.com/viewtopic.php?f=1&t=300&sid=old-session',
    'Legacy extracted thread',
    'extracted',
    'THREAD_URL: https://example.com/viewtopic.php?f=1&t=300&sid=old-session'
  );
  legacyDb.prepare(
    `INSERT INTO threads (id, forum_id, url, title, status)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    'legacy-thread-b',
    forumId,
    'https://example.com/viewtopic.php?f=1&t=300',
    'Legacy canonical thread',
    'pending'
  );
  legacyDb.prepare(
    `INSERT INTO cases (id, thread_id, payload_json, status)
     VALUES (?, ?, ?, ?)`
  ).run(
    'legacy-case-imported',
    'legacy-thread-a',
    JSON.stringify({
      case_author: 'Alice',
      resolution: 'Sensor replaced.',
      thread_url: 'https://example.com/viewtopic.php?f=1&t=300&sid=old-session',
      source_ref: 'agent:thread:https://example.com/viewtopic.php?f=1&t=300&sid=old-session',
    }),
    'imported'
  );
  legacyDb.prepare(
    `INSERT INTO cases (id, thread_id, payload_json, status)
     VALUES (?, ?, ?, ?)`
  ).run(
    'legacy-case-duplicate',
    'legacy-thread-b',
    JSON.stringify({
      case_author: 'Alice',
      resolution: 'Sensor replaced!!',
      thread_url: 'https://example.com/viewtopic.php?f=1&t=300',
      source_ref: 'agent:thread:https://example.com/viewtopic.php?f=1&t=300',
    }),
    'ai_approved'
  );
  // The legacy repair is one-shot (stamped in agent_meta). Simulating an old
  // database = injecting legacy rows AND clearing the stamp, so the next open
  // runs the repair exactly like a version bump would.
  legacyDb.prepare('DELETE FROM agent_meta WHERE key = ?').run('legacy_repair_version');
  legacyDb.close();

  state = new AgentState(dbPath);

  const repairedThread = state.getThreadByUrl('https://example.com/viewtopic.php?f=1&t=300');
  assert.equal(repairedThread?.id, 'legacy-thread-a');
  assert.equal(state.addThread({
    forumId,
    url: 'https://example.com/viewtopic.php?f=1&t=300&sid=fresh-session',
  }), 'legacy-thread-a');

  const repairedCases = state.getCasesForThread('legacy-thread-a');
  assert.equal(repairedCases.length, 1);
  assert.equal(repairedCases[0].id, 'legacy-case-imported');
  const repairedPayload = JSON.parse(repairedCases[0].payload_json);
  assert.equal(repairedPayload.thread_url, 'https://example.com/viewtopic.php?f=1&t=300');
  assert.equal(repairedPayload.source_ref, 'agent:thread:https://example.com/viewtopic.php?f=1&t=300');

  const retryThreadId = state.addThread({
    forumId,
    url: 'https://example.com/viewtopic.php?f=1&t=400',
  });
  state.addCase({
    id: 'verify-retry',
    threadId: retryThreadId,
    payload: { case_author: 'Bob', resolution: 'ok', thread_url: 'https://example.com/viewtopic.php?f=1&t=400' },
  });
  state.updateCase('verify-retry', { status: 'verify_error', verify_attempts: 2 });
  assert.equal(state.getCasesForVerification(10, 3).some(c => c.id === 'verify-retry'), true);
  state.updateCase('verify-retry', { verify_attempts: 3 });
  assert.equal(state.getCasesForVerification(10, 3).some(c => c.id === 'verify-retry'), false);

  state.addCase({
    id: 'crosscheck-retry',
    threadId: retryThreadId,
    payload: { case_author: 'Bob', resolution: 'ok', thread_url: 'https://example.com/viewtopic.php?f=1&t=400' },
  });
  state.updateCase('crosscheck-retry', { status: 'crosscheck_error', crosscheck_attempts: 2 });
  assert.equal(state.getCasesForCrosscheck(10, 3).some(c => c.id === 'crosscheck-retry'), true);

  state.addCase({
    id: 'import-retry',
    threadId: retryThreadId,
    payload: { case_author: 'Bob', resolution: 'ok', thread_url: 'https://example.com/viewtopic.php?f=1&t=400' },
  });
  state.updateCase('import-retry', { status: 'import_failed', import_attempts: 2 });
  assert.equal(state.getCasesForImport(10, 3).some(c => c.id === 'import-retry'), true);

  state.close();

  const calibrationDb = new DatabaseSync(dbPath);
  calibrationDb.exec('PRAGMA foreign_keys=ON');
  calibrationDb.prepare(
    `INSERT INTO forums (id, url, name, status, calibration_status, calibration_attempts)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    'quota-reset-forum',
    'https://retry.example.com/forum',
    'Retry Forum',
    'calibration_failed',
    'failed',
    1
  );
  calibrationDb.prepare(
    `INSERT INTO forums (id, url, name, status, calibration_status, calibration_attempts)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    'active-calibration-forum',
    'https://active.example.com/forum',
    'Active Forum',
    'active',
    'failed',
    2
  );
  calibrationDb.close();

  state = new AgentState(dbPath);
  const retriedForum = state.getForum('quota-reset-forum');
  assert.equal(retriedForum?.status, 'discovered');
  assert.equal(retriedForum?.calibration_status, 'pending');

  const activeForum = state.getForum('active-calibration-forum');
  assert.equal(activeForum?.status, 'active');
  assert.equal(activeForum?.calibration_status, 'calibrated');

  // ── agent_meta key/value store (usage-limit pause + heartbeat) ──
  assert.equal(state.getMeta('pause_until'), null);
  state.setMeta('pause_until', '2099-01-01T00:00:00.000Z');
  state.setMeta('pause_reason', 'Claude quota exhausted');
  assert.equal(state.getMeta('pause_until'), '2099-01-01T00:00:00.000Z');
  state.setMeta('pause_until', '2099-02-02T00:00:00.000Z'); // upsert overwrites
  assert.equal(state.getMeta('pause_until'), '2099-02-02T00:00:00.000Z');
  state.deleteMeta('pause_until');
  assert.equal(state.getMeta('pause_until'), null);
  assert.equal(state.getMeta('pause_reason'), 'Claude quota exhausted');

  state.close();

  const readOnlyState = new AgentState(dbPath, { readOnly: true });
  assert.equal(readOnlyState.getStats().forums >= 3, true);
  // Read-only connections must tolerate meta reads (and legacy DBs without the table)
  assert.equal(readOnlyState.getMeta('pause_reason'), 'Claude quota exhausted');
  assert.equal(readOnlyState.getMeta('nonexistent-key'), null);
  readOnlyState.close();
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can keep SQLite WAL handles around briefly; cleanup is best-effort.
  }
}

console.log('agent-state.test.js passed');
