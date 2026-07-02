import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from '../scripts/agent/state.mjs';

// Pure-logic + state coverage of the daily coach. The module guards main() to run
// only when invoked directly, so importing it here is side-effect free.
const {
  bucketDiscardReason, aggregateNight, buildReport, buildAdaptSection,
  nightCutoffUtc, gateDecision, detectDegenerate,
} = await import('../scripts/agent/daily-coach.mjs');

// ── bucketDiscardReason ─────────────────────────────────────────────────────
assert.equal(bucketDiscardReason('Too few posts'), 'too_few_posts');
assert.equal(bucketDiscardReason('Classifier rejected: unresolved thread'), 'classifier_reject');
assert.equal(bucketDiscardReason('Extractor returned no cases'), 'extractor_empty');
assert.equal(bucketDiscardReason('transient: HTTP 429'), 'transient');
assert.equal(bucketDiscardReason('something else'), 'other');
assert.equal(bucketDiscardReason(null), 'other');

// ── aggregateNight ───────────────────────────────────────────────────────────
// Extraction/discards/per-forum come from the created-tonight cohort; verify &
// import THROUGHPUT come from the runs table (what actually happened tonight),
// so a verify that lags extraction by a night is still counted correctly.
const agg = aggregateNight({
  threads: [
    { id: 't1', forum_id: 'f1', status: 'discarded', discard_reason: 'Too few posts' },
    { id: 't2', forum_id: 'f1', status: 'discarded', discard_reason: 'Classifier rejected: x' },
    { id: 't3', forum_id: 'f2', status: 'extracted' },
    { id: 't4', forum_id: 'f2', status: 'pending' }, // in-flight → excluded from processed
  ],
  cases: [
    { id: 'c1', thread_id: 't3', forum_id: 'f2', status: 'verified', review_note: 'Verifier: PASS' },
    { id: 'c2', thread_id: 't3', forum_id: 'f2', status: 'verify_rejected', review_note: 'Verifier: failed:is_genuine_fault — x' },
    { id: 'c3', thread_id: 'tX', forum_id: 'f3', status: 'imported', review_note: null }, // thread outside window, but forum_id joined
  ],
  // Runs this window: 5 passed verify, 2 rejected, 4 imported — deliberately
  // DIFFERENT from the case-cohort statuses to prove the throughput is sourced
  // from runs (the created-tonight cohort would give 2 verified / 1 imported).
  runs: [
    { cases_verified: 3, cases_verify_rejected: 1, cases_imported: 2, stop_reason: null },
    { cases_verified: 2, cases_verify_rejected: 1, cases_imported: 2, stop_reason: null },
  ],
  forums: [{ id: 'f1', name: 'Forum One' }, { id: 'f2', name: 'Forum Two' }, { id: 'f3', name: 'Forum Three' }],
});

assert.equal(agg.metrics.threads_processed, 3, 'pending thread excluded');
assert.equal(agg.metrics.threads_discarded, 2);
assert.equal(agg.metrics['discarded:too_few_posts'], 1);
assert.equal(agg.metrics['discarded:classifier_reject'], 1);
assert.equal(agg.metrics.cases_extracted, 3);
assert.equal(agg.metrics.cases_verified, 5, 'verify throughput summed from runs, not the lagging cohort');
assert.equal(agg.metrics.cases_imported, 4, 'import throughput summed from runs');
assert.equal(agg.metrics.verify_rejected, 2, 'rejections summed from runs');
assert.equal(agg.metrics['verify_reject:is_genuine_fault'], 1, 'reject-reason histogram stays cohort-based (diagnostic)');
assert.equal(agg.metrics.verify_pass_rate, +(5 / 7).toFixed(3), 'runs cohort: passed/(passed+rejected)');
assert.equal(agg.metrics.import_rate, +(4 / 5).toFixed(3), 'imported/verified, same runs cohort');

// Without `runs`, it falls back to the cohort (standalone usability preserved).
const cohortOnly = aggregateNight({
  threads: [{ id: 't3', forum_id: 'f2', status: 'extracted' }],
  cases: [
    { id: 'c1', forum_id: 'f2', status: 'verified' },
    { id: 'c3', forum_id: 'f3', status: 'imported' },
  ],
  forums: [{ id: 'f2' }, { id: 'f3' }],
});
assert.equal(cohortOnly.metrics.cases_verified, 2, 'no runs → cohort fallback (verified+imported passed verify)');
assert.equal(cohortOnly.metrics.cases_imported, 1, 'no runs → cohort fallback');
// byForum now spans the UNION of forums seen in threads OR cases (dense series),
// with per-forum processed/extracted/transient/too_few. f1 has threads but no cases
// (busy-but-barren → explicit zeros); c3 counts in f2/f3 via joined forum_id.
assert.deepEqual(agg.byForum, [
  { forum: 'Forum Two', forumId: 'f2', good: 1, rejected: 1, processed: 1, extracted: 2, transient: 0, tooFew: 0 },
  { forum: 'Forum Three', forumId: 'f3', good: 1, rejected: 0, processed: 0, extracted: 1, transient: 0, tooFew: 0 },
  { forum: 'Forum One', forumId: 'f1', good: 0, rejected: 0, processed: 2, extracted: 0, transient: 0, tooFew: 1 },
]);

// Per-forum "good" is NARROWED: crosscheck_dupe / import_failed are NOT precision
// survivors and must not inflate a forum's verified yield (they still count as extracted).
const narrowed = aggregateNight({
  threads: [{ id: 't', forum_id: 'fA', status: 'extracted' }],
  cases: [
    { id: 'k1', forum_id: 'fA', status: 'crosscheck_dupe' },
    { id: 'k2', forum_id: 'fA', status: 'import_failed' },
    { id: 'k3', forum_id: 'fA', status: 'verified' },
  ],
  forums: [{ id: 'fA', name: 'Forum A' }],
});
assert.equal(narrowed.byForum[0].good, 1, 'only verified counts as forum good; dupe/import_failed excluded');
assert.equal(narrowed.byForum[0].extracted, 3, 'all three cases still count as extracted');

// Transient threads are split out of processed (error / transient discard / pending-transient).
const trans = aggregateNight({
  threads: [
    { id: 'a', forum_id: 'fB', status: 'extracted' },
    { id: 'b', forum_id: 'fB', status: 'error' },
    { id: 'c', forum_id: 'fB', status: 'pending', discard_reason: 'transient: ECONNRESET' },
    { id: 'd', forum_id: 'fB', status: 'discarded', discard_reason: 'transient: HTTP 429' },
  ],
  cases: [],
  forums: [{ id: 'fB', name: 'Forum B' }],
});
assert.equal(trans.byForum[0].processed, 1, 'only the non-transient extracted thread is "processed"');
assert.equal(trans.byForum[0].transient, 3, 'error + pending-transient + discarded-transient all count transient');

const empty = aggregateNight({});
assert.equal(empty.metrics.threads_processed, 0);
assert.equal(empty.metrics.yield_rate, 0, 'no divide-by-zero');
assert.deepEqual(empty.byForum, []);

// ── buildReport ─────────────────────────────────────────────────────────────
const report = buildReport(agg, { date: '2026-06-18', windowLabel: '2026-06-17 21:00 → 2026-06-18 06:20 UTC (noční běh)' });
assert.match(report, /Noční report crawleru — 2026-06-18/);
assert.match(report, /Zpracovaná vlákna: \*\*3\*\*/);
assert.match(report, /Forum Two: 1 ✓ \/ 1 ✕/);
const deg = buildReport({ metrics: {}, byForum: [], rejectConditions: {}, discardBuckets: {} }, { date: '2026-06-18', degenerate: 'Noční běh skončil předčasně (quota).' });
assert.match(deg, /skončil předčasně/);
assert.doesNotMatch(deg, /Co se vytěžilo/);

// ── buildAdaptSection (Phase 2 "Co jsem automaticky upravil") ───────────────
{
  const applied = [
    { knob: 'priority', direction: 'up', forumName: 'Audi Klub', newFields: { priority_score: 27 }, signal: { good: 30, processed: 120, nights: 3, current: 12 } },
    { knob: 'cooldown', direction: 'shorten', forumName: 'Ford Club', signal: { fromTier: 168, toTier: 24, good: 7 } },
    { knob: 'cooldown', direction: 'extend', forumName: 'Dacia Club', signal: { fromTier: 24, toTier: 168 } },
  ];
  const proposals = [{ knob: 'recalibrate_proposal', forumName: 'Passat B6', signal: { nights: 3, processed: 40 } }];
  const sec = buildAdaptSection({ applied, proposals, deferred: [], circuitTripped: false, capHit: false }, 8).join('\n');
  assert.match(sec, /## Co jsem automaticky upravil/);
  assert.match(sec, /Audi Klub.*prioritu z 12 na 27/);
  assert.match(sec, /Ford Club.*ze 7 dnů na 1 den/);
  assert.match(sec, /Dacia Club.*z 1 dne na 7 dnů/);
  assert.match(sec, /### Možná potřebují ruční kontrolu struktury/);
  assert.match(sec, /Passat B6/);
  assert.match(sec, /NEZASAHOVAL jsem/);
  assert.match(sec, /apply-proposal\.mjs --revert/);

  const quiet = buildAdaptSection({ applied: [], proposals: [], deferred: [], circuitTripped: false, capHit: false }).join('\n');
  assert.match(quiet, /neprovedl žádnou automatickou úpravu/);
  const tripped = buildAdaptSection({ applied: [], proposals: [], deferred: [1, 2], circuitTripped: true, capHit: false }).join('\n');
  assert.match(tripped, /víc než polovina/);

  // Phase 2 report wires the section in (replaces the Phase-1 "jen měřím" footer).
  const withPlan = buildReport(agg, { date: '2026-06-18', windowLabel: 'x', plan: { applied, proposals, deferred: [], circuitTripped: false, capHit: false } });
  assert.match(withPlan, /## Co jsem automaticky upravil/);
}

// ── nightCutoffUtc (anchored to most-recent night start, not rolling) ───────
{
  const morning = new Date(2026, 5, 18, 6, 20);   // 06:20 local → night started yesterday 21:00
  const expectedMorning = new Date(2026, 5, 17, 21, 0, 0, 0).toISOString().slice(0, 19).replace('T', ' ');
  assert.equal(nightCutoffUtc(morning, 21), expectedMorning);
  const evening = new Date(2026, 5, 18, 22, 0);   // 22:00 local → tonight's start (today 21:00)
  const expectedEvening = new Date(2026, 5, 18, 21, 0, 0, 0).toISOString().slice(0, 19).replace('T', ' ');
  assert.equal(nightCutoffUtc(evening, 21), expectedEvening);
}

// ── gateDecision (closed morning window + once-per-day) ─────────────────────
assert.equal(gateDecision(new Date(2026, 5, 18, 6, 20), { lastDate: '2026-06-17', today: '2026-06-18' }).run, true);
assert.equal(gateDecision(new Date(2026, 5, 18, 21, 0), { lastDate: null, today: '2026-06-18' }).run, false, 'evening excluded');
assert.equal(gateDecision(new Date(2026, 5, 18, 3, 0), { lastDate: null, today: '2026-06-18' }).run, false, 'night excluded');
assert.equal(gateDecision(new Date(2026, 5, 18, 10, 0), { lastDate: '2026-06-18', today: '2026-06-18' }).run, false, 'already ran today');

// ── detectDegenerate (quota stop anywhere in window, or empty window) ───────
assert.match(detectDegenerate({ runs: [{ stop_reason: null }, { stop_reason: 'quota limit reached' }], threads: [{}], cases: [] }), /předčasně/);
assert.equal(detectDegenerate({ runs: [], threads: [], cases: [] }) === null, false, 'empty window is degenerate');
assert.equal(detectDegenerate({ runs: [{ stop_reason: null }], threads: [{ id: 't' }], cases: [] }), null, 'clean night');

// ── state: metrics upsert + windowed readers ────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'agent-coach-state-'));
try {
  const state = new AgentState(join(dir, 'agent.db'));

  // recordMetric upsert + getMetricSeries ordering (oldest→newest)
  state.recordMetric('2026-06-16', 'cases_verified', 10);
  state.recordMetric('2026-06-17', 'cases_verified', 20);
  state.recordMetric('2026-06-17', 'cases_verified', 25); // upsert same key
  const series = state.getMetricSeries('cases_verified');
  assert.deepEqual(series.map(r => r.date), ['2026-06-16', '2026-06-17']);
  assert.equal(series[1].value, 25, 'ON CONFLICT upsert overwrote');
  assert.equal(state.getMetricsForDate('2026-06-17').cases_verified, 25);

  // windowed readers + forum_id join on cases
  const fid = state.addForum({ url: 'https://prio.example/forum', name: 'Prio' });
  const tid = state.addThread({ forumId: fid, url: 'https://prio.example/viewtopic.php?t=1' });
  state.addCase({ id: 'case-xyz', threadId: tid, payload: { brand_raw: 'Audi' } });
  state.updateCase('case-xyz', { status: 'verified' });

  const past = '2000-01-01 00:00:00';
  const future = '2999-01-01 00:00:00';
  assert.equal(state.getThreadsCreatedSince(past).length >= 1, true);
  assert.equal(state.getThreadsCreatedSince(future).length, 0, 'future cutoff → none');
  const cs = state.getCasesCreatedSince(past);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].forum_id, fid, 'case carries joined forum_id');
  assert.equal(cs[0].status, 'verified');

  // last_processed_at: NULL until the crawler assigns a status, then stamped — so
  // the "processed" window counts archive re-processing, not just fresh discovery.
  assert.equal(state.getThreadsProcessedSince(past).length, 0, 'undiscovered-processed thread not in processed window');
  state.updateThread(tid, { status: 'extracted' });
  const proc = state.getThreadsProcessedSince(past);
  assert.equal(proc.length, 1, 'status assignment stamps last_processed_at → enters processed window');
  assert.equal(proc[0].last_processed_at != null, true, 'last_processed_at stamped');
  assert.equal(state.getThreadsProcessedSince(future).length, 0, 'future cutoff → none processed');
  // Explicit last_processed_at is honoured (not overwritten by the auto-stamp).
  state.updateThread(tid, { status: 'discarded', last_processed_at: '2001-01-01 00:00:00' });
  assert.equal(state.getThreadsProcessedSince('2002-01-01 00:00:00').length, 0, 'explicit stamp wins over auto-stamp');

  state.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('agent-daily-coach.test.js passed');
