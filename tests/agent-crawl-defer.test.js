import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { processThread, minThreadAgeMs } from '../scripts/agent/crawl.mjs';
import { parseWhenToDate, threadLastActivity, selectPosts } from '../scripts/agent/parsers/common.mjs';
import { AgentState } from '../scripts/agent/state.mjs';
import { classifyDiscardReason, selectRecoverable } from '../scripts/agent/recover-discarded.mjs';

const DAY = 24 * 60 * 60 * 1000;
const YEAR = minThreadAgeMs(); // the live age threshold (default 365d)

// ───────────────────────────────────────────────────────────────────────────
// parseWhenToDate — ISO + bare epoch + EU deterministic absolute dates;
// ambiguous (slash), relative, 2-digit-year, or invalid => null (unknown = process now)
// ───────────────────────────────────────────────────────────────────────────
assert.equal(parseWhenToDate('2024-03-11T08:22:00+0000'), Date.parse('2024-03-11T08:22:00+0000'), 'ISO with numeric offset');
assert.equal(parseWhenToDate('2024-03-11T08:22:00.000Z'), Date.parse('2024-03-11T08:22:00.000Z'), 'ISO with Z + ms');
assert.equal(parseWhenToDate('2024-03-11'), Date.parse('2024-03-11'), 'ISO date-only');
assert.equal(parseWhenToDate('1710144120'), 1710144120 * 1000, '10-digit unix seconds → ms');
assert.equal(parseWhenToDate('1710144120000'), 1710144120000, '13-digit unix ms');

// EU absolute dates now RE-ARM the age gate (all resolve to 2024-03-15 UTC).
const MAR15 = Date.UTC(2024, 2, 15);
assert.equal(parseWhenToDate('15.03.2024'), MAR15, 'dd.mm.yyyy (EU dot = day-first)');
assert.equal(parseWhenToDate('15. 3. 2024'), MAR15, 'dd. m. yyyy with spaces (Czech)');
assert.equal(parseWhenToDate('st 15. 03. 2024 14:23'), MAR15, 'EU date embedded in a longer visible string');
assert.equal(parseWhenToDate('15. března 2024'), MAR15, 'Czech genitive month name');
assert.equal(parseWhenToDate('15. März 2024'), MAR15, 'German month name (umlaut folded)');
assert.equal(parseWhenToDate('15 March 2024'), MAR15, 'English day month year');
assert.equal(parseWhenToDate('March 15, 2024'), MAR15, 'English month day, year');
assert.equal(parseWhenToDate('2024.03.15'), MAR15, 'year-first dotted');
assert.equal(parseWhenToDate('11. listopadu 2023'), Date.UTC(2023, 10, 11), 'Czech November genitive');

// Still null: ambiguous / relative / unreliable → safe "process now".
assert.equal(parseWhenToDate('vor 2 Stunden'), null, 'German relative → null');
assert.equal(parseWhenToDate('včera'), null, 'Czech relative → null');
assert.equal(parseWhenToDate('03/04/2024'), null, 'slash dd/mm is US↔EU ambiguous → null');
assert.equal(parseWhenToDate('15.03.24'), null, '2-digit year → null (century ambiguous)');
assert.equal(parseWhenToDate('32.01.2024'), null, 'invalid day → null');
assert.equal(parseWhenToDate('15.13.2024'), null, 'invalid month → null');
assert.equal(parseWhenToDate('31.02.2024'), null, 'calendar overflow (Feb 31) → null');
assert.equal(parseWhenToDate('garbage'), null, 'garbage → null');
assert.equal(parseWhenToDate(''), null, 'empty → null');
assert.equal(parseWhenToDate(null), null, 'null → null');

// ───────────────────────────────────────────────────────────────────────────
// threadLastActivity — newest parseable date wins; unknowns ignored
// ───────────────────────────────────────────────────────────────────────────
assert.equal(
  threadLastActivity([
    { when: '2020-01-01T00:00:00Z' },
    { when: '2022-06-01T00:00:00Z' },
    { when: 'vor 2 Stunden' },
  ]),
  Date.parse('2022-06-01T00:00:00Z'),
  'returns the newest parseable post date'
);
assert.equal(threadLastActivity([{ when: '' }, { when: 'včera' }]), null, 'all-unknown → null');
assert.equal(threadLastActivity([]), null, 'no posts → null');

// ───────────────────────────────────────────────────────────────────────────
// processThread — the post-fetch age gate
// ───────────────────────────────────────────────────────────────────────────
const now = Date.parse('2026-06-25T12:00:00Z');

function mockPipeline(posts, spy = {}) {
  return {
    async fetchAndParse() {
      return { posts, threadText: 'THREAD', title: 'A title', html: '', pageCount: 1 };
    },
    async classify() { spy.classified = true; return { approved: true, reason: '' }; },
    async extract() { spy.extracted = true; return [{ description: 'fault', resolution: 'the fix' }]; },
    validate() { return { valid: true }; },
  };
}

// (a) Newest post younger than the threshold → DEFERRED, no LLM, revisit recorded.
{
  const newest = now - YEAR / 2;
  const spy = {};
  const r = await processThread('u', {}, mockPipeline([
    { when: new Date(now - 2 * YEAR).toISOString() }, // old opening post
    { when: new Date(newest).toISOString() },         // newest reply, still young
  ], spy), { now });
  assert.equal(r.deferred, true, 'thread whose newest post is <1yr is deferred');
  assert.equal(r.cases.length, 0, 'deferred thread yields no cases');
  assert.equal(spy.classified, undefined, 'deferred thread never reaches the classifier (no AI cost)');
  assert.equal(r.lastPostAt, new Date(newest).toISOString(), 'records the last-post date');
  assert.equal(r.revisitAfter, new Date(newest + YEAR).toISOString(), 'revisit = last post + 1 year');
}

// (b) Newest post older than the threshold → processed normally (classify+extract).
{
  const spy = {};
  const r = await processThread('u', {}, mockPipeline([
    { when: new Date(now - 3 * YEAR).toISOString() },
    { when: new Date(now - 2 * YEAR).toISOString() },
  ], spy), { now });
  assert.equal(r.deferred, undefined, 'matured thread (newest >1yr) is NOT deferred');
  assert.equal(spy.classified && spy.extracted, true, 'matured thread proceeds to classify + extract');
  assert.equal(r.cases.length, 1, 'matured thread can yield a case');
}

// (c) Unparseable/localized dates → unknown age → processed now (never silently dropped).
{
  const spy = {};
  const r = await processThread('u', {}, mockPipeline([
    { when: 'včera' },
    { when: '' },
  ], spy), { now });
  assert.equal(r.deferred, undefined, 'unknown-age thread is processed now, not deferred');
  assert.equal(spy.classified, true, 'unknown-age thread reaches the classifier');
}

// (d) Too-few-posts guard still wins over the age gate.
{
  const r = await processThread('u', {}, mockPipeline([{ when: new Date(now).toISOString() }]), { now });
  assert.equal(r.skipped, 'Too few posts', 'single-post thread short-circuits before the age gate');
  assert.equal(r.deferred, undefined);
}

// (e) MOVED-TRAP regression: a thread too-young at first contact matures and is then
//     processed IN PLACE — the resolution that lands later is captured, never buried.
{
  const lastPost = now - 0.8 * YEAR;            // young at first contact
  const first = await processThread('u', {}, mockPipeline([
    { when: new Date(now - 1.5 * YEAR).toISOString() },
    { when: new Date(lastPost).toISOString() },
  ]), { now });
  assert.equal(first.deferred, true, 'too-young at first contact → deferred');

  const dueMs = Date.parse(first.revisitAfter);
  const later = now + (dueMs - now) + DAY; // a day after it matures
  const spy = {};
  const r = await processThread('u', {}, mockPipeline([
    { when: new Date(lastPost).toISOString() },
    { when: new Date(lastPost).toISOString() }, // the now-present resolution post
  ], spy), { now: later });
  assert.equal(r.deferred, undefined, 'after maturing it is processed, not deferred again');
  assert.equal(spy.extracted, true, 'the matured thread is extracted — late resolution captured');
}

// (f) FUTURE-dated newest post (clock skew / wrong-TZ / typo year) => treat as
//     mature now and process; never park a ready thread for years.
{
  const spy = {};
  const r = await processThread('u', {}, mockPipeline([
    { when: new Date(now - 3 * YEAR).toISOString() },
    { when: new Date(now + 30 * DAY).toISOString() }, // future
  ], spy), { now });
  assert.equal(r.deferred, undefined, 'future-dated newest post is treated as mature (processed now)');
  assert.equal(spy.classified, true, 'future-dated thread reaches the classifier');
}

// (g) Calibrated-selector path reads the ISO datetime ATTRIBUTE, not the localized
//     visible text — otherwise the age gate is inert on profiled forums.
{
  const html = `
    <div class="post">
      <span class="author">Alice</span>
      <time class="date" datetime="2020-05-01T10:00:00+0000">1. května 2020</time>
      <div class="body">Engine fault: lost power and threw P0299; replacing the boost hose fixed it, confirmed after 300 km.</div>
    </div>
    <div class="post">
      <span class="author">Bob</span>
      <time class="date" datetime="2020-05-03T10:00:00+0000">vor 2 Jahren</time>
      <div class="body">Same model and engine here — the same boost hose repair solved it for me as well, thanks.</div>
    </div>`;
  const cal = { post_selector: 'div.post', author_selector: 'span.author', date_selector: 'time.date', content_selector: 'div.body' };
  const posts = selectPosts(html, cal, 1);
  assert.equal(posts.length, 2, 'selectPosts found both posts');
  assert.equal(posts[0].when, '2020-05-01T10:00:00+0000', 'date taken from datetime attribute, not the localized text');
  assert.equal(threadLastActivity(posts), Date.parse('2020-05-03T10:00:00+0000'), 'thread last-activity derived from the ISO attrs');
}

// ───────────────────────────────────────────────────────────────────────────
// state — defer status, revive-when-due, persistence, crawled-count exclusion
// ───────────────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'agent-defer-test-'));
const dbPath = join(dir, 'agent.db');
try {
  let state = new AgentState(dbPath);
  const forumId = state.addForum({ url: 'https://defer.example/forum' });

  const past = new Date(Date.now() - DAY).toISOString();     // due → should revive
  const future = new Date(Date.now() + 30 * DAY).toISOString(); // not due → stays

  const tDue = state.addThread({ forumId, url: 'https://defer.example/t-due' });
  state.updateThread(tDue, { status: 'deferred', revisit_after: past });
  const tWait = state.addThread({ forumId, url: 'https://defer.example/t-wait' });
  state.updateThread(tWait, { status: 'deferred', revisit_after: future });
  const tDone = state.addThread({ forumId, url: 'https://defer.example/t-done' });
  state.updateThread(tDone, { status: 'extracted' });

  assert.equal(state.countDeferredThreads(forumId), 2, 'two deferred threads');
  assert.equal(state.countCrawledThreads(forumId), 1, 'only extracted counts as crawled (deferred excluded)');

  const revived = state.reviveDueDeferredThreads(forumId);
  assert.equal(revived, 1, 'only the past-due deferred thread is revived');
  assert.equal(state.getThread(tDue).status, 'pending', 'matured deferred thread → pending');
  assert.equal(state.getThread(tWait).status, 'deferred', 'not-yet-due deferred thread stays deferred');
  assert.equal(state.countPendingThreads(forumId), 1, 'revived thread is queued');
  assert.equal(state.countDeferredThreads(forumId), 1, 'one still waiting');

  // revisit_after must survive updateThread (allow-list) AND a reopen (#migrate/#repair).
  assert.equal(state.getThread(tWait).revisit_after, future, 'revisit_after persisted via updateThread');
  state.close();
  state = new AgentState(dbPath);
  assert.equal(state.getThread(tWait).revisit_after, future, 'revisit_after survives reopen + legacy repair');
  assert.equal(state.getThread(tWait).status, 'deferred', 'deferred status survives reopen');
  state.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ───────────────────────────────────────────────────────────────────────────
// recover-discarded — selection of previously-discarded threads to re-queue
// ───────────────────────────────────────────────────────────────────────────
assert.equal(classifyDiscardReason('Too few posts'), 'too_few');
assert.equal(classifyDiscardReason('Classifier rejected: Thread is a forum rules page, not a discussion'), 'terminal');
assert.equal(classifyDiscardReason('Classifier rejected: request for a service manual, not a fault'), 'terminal');
assert.equal(classifyDiscardReason('Classifier rejected: Tool recommendation thread.'), 'terminal');
assert.equal(classifyDiscardReason('Extractor returned no cases'), 'recoverable');
assert.equal(classifyDiscardReason('Classifier rejected: Unresolved thread. user describes a genuine fault'), 'recoverable');
assert.equal(classifyDiscardReason('Classifier rejected: no confirmed resolution for any described fault'), 'recoverable');
// default-recover: a genuine reason mentioning "buy" must NOT be mis-bucketed terminal
assert.equal(classifyDiscardReason('Classifier rejected: no fix; user said they would buy a new coil and report back'), 'recoverable');
assert.equal(classifyDiscardReason('something unexpected'), 'recoverable', 'any real reason defaults to recoverable');
assert.equal(classifyDiscardReason(''), 'other', 'empty reason → other (no re-fetch)');
assert.equal(classifyDiscardReason('   '), 'other', 'whitespace-only → other');
assert.equal(classifyDiscardReason(null), 'other', 'null → other');

{
  const rows = [
    { id: 'a', forum_id: 'f1', discard_reason: 'Too few posts' },
    { id: 'b', forum_id: 'f1', discard_reason: 'Extractor returned no cases' },
    { id: 'c', forum_id: 'f2', discard_reason: 'Classifier rejected: Unresolved thread' },
    { id: 'd', forum_id: 'f1', discard_reason: 'Classifier rejected: forum rules page' },
  ];
  const r1 = selectRecoverable(rows, {});
  assert.deepEqual(r1.selected.map(x => x.id), ['b', 'c'], 'recoverable only by default');
  assert.equal(r1.buckets.too_few, 1);
  assert.equal(r1.buckets.terminal, 1);
  const r2 = selectRecoverable(rows, { includeTooFew: true });
  assert.deepEqual(r2.selected.map(x => x.id).sort(), ['a', 'b', 'c'], 'too_few included on opt-in');
  const r3 = selectRecoverable(rows, { forumId: 'f1' });
  assert.deepEqual(r3.selected.map(x => x.id), ['b'], 'forum filter restricts selection');
  assert.equal(r3.buckets.recoverable, 1, 'buckets are forum-scoped (only f1 rows counted)');
  const r4 = selectRecoverable(rows, { limit: 1 });
  assert.equal(r4.selected.length, 1, 'limit caps selection');
}

// ───────────────────────────────────────────────────────────────────────────
// state — legacy repair keeps the re-checkable 'deferred' row over a discarded
// duplicate (post-canonicalization-change safety; revisit_after preserved)
// ───────────────────────────────────────────────────────────────────────────
{
  const dir2 = mkdtempSync(join(tmpdir(), 'agent-defer-repair-'));
  const dbPath2 = join(dir2, 'agent.db');
  try {
    const future = new Date(Date.now() + 100 * DAY).toISOString();
    let st = new AgentState(dbPath2);
    const fid = st.addForum({ url: 'https://x.example/forum' });
    const a = st.addThread({ forumId: fid, url: 'https://x.example/viewtopic.php?f=1&t=7' });
    st.updateThread(a, { status: 'discarded', discard_reason: 'old premature discard' });
    st.close();
    // Inject a DUPLICATE (same canonical URL, stored with a session id as an old
    // canonicalization would have) in status 'deferred'. addThread would dedup it,
    // so insert raw to simulate a post-canonicalization-change duplicate.
    const raw = new DatabaseSync(dbPath2);
    raw.prepare("INSERT INTO threads (id, forum_id, url, status, revisit_after) VALUES (?,?,?,?,?)")
      .run('dupB', fid, 'https://x.example/viewtopic.php?f=1&t=7&sid=ZZZ', 'deferred', future);
    // The legacy repair is one-shot (stamped in agent_meta) — clear the stamp so
    // the reopen runs it, exactly like a canonicalization version bump would.
    raw.prepare("DELETE FROM agent_meta WHERE key = 'legacy_repair_version'").run();
    raw.close();
    // Reopen → #repairLegacyThreads merges the canonical group.
    st = new AgentState(dbPath2);
    const survivors = [...st.getThreadsByStatus('deferred'), ...st.getThreadsByStatus('discarded')];
    assert.equal(survivors.length, 1, 'duplicate canonical rows collapsed to one');
    assert.equal(survivors[0].status, 'deferred', 'deferred row wins over the discarded duplicate (stays re-checkable)');
    assert.equal(survivors[0].revisit_after, future, 'revisit_after preserved through legacy repair');
    st.close();
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
}

console.log('agent-crawl-defer.test.js passed');
