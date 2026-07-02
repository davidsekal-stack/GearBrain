#!/usr/bin/env node --experimental-sqlite
/**
 * orchestrator.mjs — Main loop for the autonomous crawl agent.
 *
 * Phases:
 *   1. DISCOVER  — find new forums via web search
 *   2. CALIBRATE — probe + adapt parser for each new forum
 *   3. CRAWL     — fetch threads, classify, extract cases
 *   4. VALIDATE  — deterministic gates (L4)
 *   5. VERIFY    — independent AI audit (L5)
 *   6. CROSSCHECK— dedupe vs. Supabase (L6)
 *   7. IMPORT    — push verified cases to Supabase
 *
 * Usage:
 *   node --experimental-sqlite scripts/agent/orchestrator.mjs [options]
 *
 * Options:
 *   --batch-size <n>    Threads per batch (default: 20)
 *   --sleep-ms <n>      Delay between HTTP requests (default: 600)
 *   --continuous         Keep running in a loop
 *   --phase <name>       Run only one phase: discover|calibrate|crawl|verify|crosscheck|import
 *   --forum-url <url>    Seed a specific forum URL
 *   --stats              Print stats and exit
 */

import { AgentState } from './state.mjs';
import { calibrateForum, isTransientCrawlerError } from './calibrate.mjs';
import { verifyCase } from './verify.mjs';
import { createCrawlPipeline, processThread, enumerateThreadUrlsDeep } from './crawl.mjs';
import { loadCrawledIndex, isThreadAlreadyExtracted } from './crawled-index.mjs';
import { resolveVehicle } from './vehicle-resolver.mjs';
import { writeDiary } from './diary.mjs';
import { discoverCandidates } from './discover.mjs';
import { upsertForum } from './forum-registry.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { QuotaError, AuthError, isStoppingError, formatQuotaMessage } from './quota.mjs';
import {
  computePauseUntil,
  enterQuotaPause,
  clearQuotaPause,
  recordSuccessHeartbeat,
  getActivePause,
  QUOTA_EXIT_CODE,
} from './pause.mjs';
import {
  clampResolutionForImport,
  crosscheckCaseAgainstSupabase,
  normalizeImportText,
  normalizeForDedupe,
  RESOLUTION_MIN_LENGTH,
  resolveSupabaseFunctionKey,
  resolveSupabaseReadKey,
} from './supabase-utils.mjs';

// Supabase project URL is public; credentials must come from environment.
const SUPABASE_DEFAULTS = {
  url: 'https://nmvjthfezyjcwuzphiuu.supabase.co',
};

const VERIFY_RETRY_LIMIT = 3;
const CROSSCHECK_RETRY_LIMIT = 3;
const IMPORT_RETRY_LIMIT = 3;
const DISCOVERY_BATCH_SIZE = 10;
const LOCAL_DUPLICATE_STATUSES = new Set(['verified', 'import_ready', 'imported', 'crosscheck_dupe']);

// Usage-limit pause + heartbeat live in pause.mjs (testable). Auth failures do
// NOT pause (a human must re-login) — they set a stop reason so the heartbeat
// is skipped and the wrapper's stall alarm reaches the owner.
const AUTH_EXIT_CODE = 76;

// ── Night-window deadline ──
// The nightly wrapper (run-agent-batch.ps1) passes AGENT_DEADLINE_EPOCH_MS =
// window end (06:00) minus a safety margin. Task Scheduler's StopAtDurationEnd
// kills only the PowerShell wrapper — the node child survived it and kept
// crawling unsupervised past 06:00, overlapping the 06:20 coach chain on the
// same agent.db (SQLITE_BUSY risk; 17 dangling runs rows). Past the deadline
// the orchestrator stops STARTING new work and exits cleanly. No env var → no
// deadline (manual daytime runs are unaffected).
const RUN_DEADLINE_MS = Number(process.env.AGENT_DEADLINE_EPOCH_MS) || null;
function pastDeadline() {
  return RUN_DEADLINE_MS !== null && Date.now() >= RUN_DEADLINE_MS;
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    batchSize: 20,
    sleepMs: 600,
    continuous: false,
    phase: null,
    forumUrl: null,
    stats: false,
    diary: false,
    force: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--batch-size':  opts.batchSize = Number(args[++i]) || 20; break;
      case '--sleep-ms':    opts.sleepMs = Number(args[++i]) || 600; break;
      case '--continuous':  opts.continuous = true; break;
      case '--phase':       opts.phase = args[++i]; break;
      case '--forum-url':   opts.forumUrl = args[++i]; break;
      case '--stats':       opts.stats = true; break;
      case '--diary':       opts.diary = true; break;
      case '--force':       opts.force = true; break;
    }
  }
  return opts;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Logging — console + SQLite agent_log table
// ---------------------------------------------------------------------------

let _logState = null; // set in main()
let _logPhase = null;

function setLogState(state) { _logState = state; }
function setLogPhase(phase) { _logPhase = phase; }

function log(level, message) {
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  const prefix = level === 'error' ? '  ✗' : level === 'warn' ? '  ⚠' : '  ·';
  if (level === 'error') console.error(`${prefix} ${message}`);
  else console.log(`${prefix} ${message}`);
  try { _logState?.log(level, message, _logPhase); } catch { /* non-fatal */ }
}

function logWarn(msg)  { log('warn',  msg); }
function logError(msg) { log('error', msg); }
function logInfo(msg)  { log('info',  msg); }

// ---------------------------------------------------------------------------
// Phase: STATS
// ---------------------------------------------------------------------------

function printStats(state) {
  const stats = state.getStats();
  console.log('\n═══ AGENT STATUS ═══');
  console.log(`Forums: ${stats.forums}`);

  // Per-forum detail
  if (stats.forums_detail?.length > 0) {
    console.log('\nForum detail:');
    for (const f of stats.forums_detail) {
      const name = f.name || new URL(f.url).hostname;
      const cooldown = f.cooldown_until
        ? (new Date(f.cooldown_until) > new Date()
          ? `⏸ cooldown until ${f.cooldown_until.slice(0, 10)}`
          : '✓ cooldown expired')
        : '';
      const yield_ = f.threads_crawled > 0
        ? `${f.cases_total || 0} cases / ${f.threads_crawled} threads (${((f.cases_total || 0) / f.threads_crawled * 100).toFixed(1)}% yield)`
        : 'not yet crawled';
      console.log(`  ${f.status.padEnd(12)} ${name}`);
      console.log(`             ${yield_}${cooldown ? '  ' + cooldown : ''}`);
      if (f.last_crawled_at) console.log(`             last crawl: ${f.last_crawled_at.slice(0, 16)}, new last batch: ${f.new_threads_last_batch ?? '?'}`);
      if (f.diary_md) {
        // Show just the first line of diary (the title/headline)
        const diaryHead = f.diary_md.split('\n').find(l => l.trim()) || '';
        console.log(`             📓 ${diaryHead.replace(/^#+\s*/, '').slice(0, 80)}`);
      }
    }
  }

  console.log('\nThreads:');
  for (const [status, count] of Object.entries(stats.threads_by_status)) {
    console.log(`  ${status}: ${count}`);
  }
  console.log('\nCases:');
  for (const [status, count] of Object.entries(stats.cases_by_status)) {
    console.log(`  ${status}: ${count}`);
  }
  if (stats.last_run) {
    const lr = stats.last_run;
    console.log(`\nLast run: ${lr.started_at} (${lr.mode})`);
    console.log(`  threads: ${lr.threads_processed}, cases: ${lr.cases_extracted}, verified: ${lr.cases_verified}, imported: ${lr.cases_imported}`);
    if (lr.stop_reason) console.log(`  stop reason: ${lr.stop_reason}`);
  }

  // Recent agent log entries
  const logs = state.getRecentLogs(20);
  if (logs.length > 0) {
    console.log('\nRecent log (last 20):');
    for (const entry of logs) {
      const ts = formatLogTimestamp(entry.ts);
      const phase = entry.phase ? `[${entry.phase}] ` : '';
      const icon = entry.level === 'error' ? '✗' : entry.level === 'warn' ? '⚠' : '·';
      console.log(`  ${ts} ${icon} ${phase}${entry.message}`);
    }
  }
}

function printDiaries(state) {
  const forums = state.getAllForums().filter(f => f.diary_md);
  if (forums.length === 0) {
    console.log('No forum diaries written yet.');
    return;
  }
  console.log(`\n═══ FORUM DIARIES (${forums.length}) ═══`);
  for (const f of forums) {
    const name = f.name || new URL(f.url).hostname;
    const crawled = f.last_crawled_at?.slice(0, 10) ?? '?';
    const yield_ = f.threads_crawled > 0
      ? `${f.cases_total || 0}/${f.threads_crawled} (${((f.cases_total || 0) / f.threads_crawled * 100).toFixed(1)}%)`
      : 'no data';
    console.log(`\n── ${name} · ${f.language} · ${f.parser} · crawled ${crawled} · yield ${yield_} ──`);
    console.log(f.diary_md);
  }
}

// ---------------------------------------------------------------------------
// Phase: DISCOVER — find new forums
// ---------------------------------------------------------------------------

async function phaseDiscover(state, opts) {
  console.log('\n── Phase: DISCOVER ──');

  // If a specific forum URL was provided, seed it directly
  if (opts.forumUrl) {
    // Domain-level dedup: check if any forum on the same domain already exists
    const sameDomain = state.getForumsByDomain(opts.forumUrl);
    if (sameDomain.length > 0) {
      const existing = sameDomain.map(f => `${f.name || f.url} [${f.status}]`).join(', ');
      console.log(`  ⚠ Domain already known: ${existing}`);
      console.log(`  Skipping — use --force to add anyway.`);
      if (!opts.force) return;
    }

    const id = state.addForum({ url: opts.forumUrl });
    console.log(`  Seeded forum: ${opts.forumUrl} (${id.slice(0, 8)})`);
    return;
  }

  const candidates = loadForumCandidates();
  if (candidates.length === 0) {
    console.log('  No forum candidates available.');
    return;
  }

  let added = 0;
  let skipped = 0;
  const limit = Math.min(DISCOVERY_BATCH_SIZE, Math.max(1, opts.batchSize || DISCOVERY_BATCH_SIZE));

  for (const candidate of candidates) {
    if (added >= limit) break;
    if (!candidate.url) {
      skipped++;
      continue;
    }

    const sameDomain = state.getForumsByDomain(candidate.url);
    if (sameDomain.length > 0) {
      skipped++;
      continue;
    }

    const id = state.addForum({
      url: candidate.url,
      name: candidate.name,
      brand: Array.isArray(candidate.brands) ? candidate.brands.join(', ') : candidate.brand,
      language: candidate.language,
      parser: candidate.parser || 'generic',
    });
    console.log(`  Seeded candidate #${candidate.rank ?? '?'}: ${candidate.name || candidate.url} (${id.slice(0, 8)})`);
    added++;
  }

  console.log(`  Discovery seeded ${added} candidate(s), skipped ${skipped}.`);

  // Live web discovery — only when the crawlable pool is running low and we
  // haven't searched recently. Bounded + rotated inside discoverCandidates.
  await maybeRunLiveDiscovery(state, opts);
}

// Run live discovery sparingly: it costs web-search calls and we usually have
// a backlog. Trigger only when few forums are ready to crawl AND discovery
// hasn't run in the last DISCOVERY_MIN_INTERVAL_MS.
const DISCOVERY_MIN_INTERVAL_MS = 24 * 3600_000;
const DISCOVERY_LOW_POOL = 3;
// Hard cap: at most one live-discovery attempt per process, so a `--continuous`
// loop (or `--phase discover --continuous`) can never re-fire web searches every
// 60s. The scheduled wrapper runs one-shot, so this doesn't limit production.
let liveDiscoveryAttemptedThisProcess = false;

async function maybeRunLiveDiscovery(state, opts) {
  if (opts.phase && opts.phase !== 'discover') return; // only in full runs / explicit discover
  if (process.env.AGENT_DISABLE_LIVE_DISCOVERY === '1') return;
  if (liveDiscoveryAttemptedThisProcess) return;

  // "Crawlable" means calibrated (matches phaseCrawl) — discovered-but-uncalibrated
  // forums are pipeline backlog, not ready targets.
  const ready = state.getForumsToProcess(50).filter(f => f.calibration_status === 'calibrated').length;
  // A manual `--phase discover`/`--force` may run on a full pool, but the 24h
  // interval is ALWAYS honored so nothing can hammer web search.
  const force = opts.phase === 'discover' || opts.force;
  if (!force && ready >= DISCOVERY_LOW_POOL) {
    console.log(`  Live discovery skipped: ${ready} calibrated forum(s) still crawlable.`);
    return;
  }

  const last = Number(state.getMeta('last_discovery_at')) || 0;
  const since = Date.now() - last;
  if (since < DISCOVERY_MIN_INTERVAL_MS) {
    console.log(`  Live discovery skipped: ran ${Math.round(since / 3600_000)}h ago (min interval 24h).`);
    return;
  }

  console.log('  Running live web discovery...');
  liveDiscoveryAttemptedThisProcess = true;
  // Stamp before the attempt so even a thrown failure counts against the 24h
  // window (a persistently failing discovery must not retry every batch).
  state.setMeta('last_discovery_at', String(Date.now()));
  try {
    const result = await discoverCandidates(state, { log: msg => console.log(msg) });
    logInfo(`Live discovery queued ${result.added} forum(s) from ${result.queries} queries.`);
  } catch (err) {
    if (isStoppingError(err)) throw err;
    logWarn(`Live discovery failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Phase: CALIBRATE — probe + adapt new forums
// ---------------------------------------------------------------------------

async function phaseCalibrate(state, opts) {
  console.log('\n── Phase: CALIBRATE ──');

  const uncalibrated = state.getForumsPendingCalibration(10);

  if (uncalibrated.length === 0) {
    console.log('  No forums pending calibration.');
    return;
  }

  for (const forum of uncalibrated) {
    console.log(`  Calibrating: ${forum.name || forum.url}`);

    // Build pipeline functions for calibration probe
    // These will be wired to actual implementations in crawl.mjs, classify.mjs, etc.
    const pipeline = buildCalibrationPipeline(opts);

    try {
      const result = await calibrateForum(state, forum.id, pipeline);
      if (result.success) {
        console.log(`  ✓ ${forum.url} calibrated in ${result.attempts} attempt(s)`);
      } else if (result.transient) {
        console.log(`  ⏸ ${forum.url} deferred: ${result.reason}`);
      } else {
        console.log(`  ✗ ${forum.url} calibration failed`);
      }
    } catch (err) {
      if (isStoppingError(err)) {
        throw err;
      }
      console.error(`  Error calibrating ${forum.url}: ${err.message}`);
      const until = new Date(Date.now() + COOLDOWN_HOURS_SHORT * 3600_000).toISOString();
      state.updateForum(forum.id, {
        calibration_status: 'pending',
        cooldown_until: until,
        // Error/transient park — clear the yield-tier markers so the daily coach
        // never mistakes this for a clean yield-based cooldown it may retune.
        cooldown_tier_hours: null,
        cooldown_set_at: null,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Phase: CRAWL — fetch threads, classify, extract
// ---------------------------------------------------------------------------

// Cooldown / pacing constants. Archive mining redefines "exhausted": a forum
// rests only once its WHOLE archive has been walked (cursor.complete) AND the
// pending queue is drained — not when a recent-window sample looks stale.
const COOLDOWN_HOURS_SHORT = 24;       // transient enumeration error → retry tomorrow
const COOLDOWN_HOURS_EXHAUSTED = 720;  // archive fully mined → rest 30 days

// Archive walk pacing.
const ARCHIVE_PAGES_PER_BATCH = 2;     // listing pages to advance per forum per batch
const HEAD_SCAN_PAGES = 2;             // shallow head re-scan for new threads once complete

async function phaseCrawl(state, opts) {
  console.log('\n── Phase: CRAWL ──');

  // Get calibrated forums (respects cooldown_until from state)
  const forums = state.getForumsToProcess(10);
  const ready = forums.filter(f => f.calibration_status === 'calibrated');

  if (ready.length === 0) {
    console.log('  No calibrated forums ready for crawling.');
    return;
  }

  const pipeline = createCrawlPipeline({ sleepMs: opts.sleepMs });
  // Cross-source "already extracted" index (DB-derived: covers legacy forum-seed
  // scripts + NHTSA + prior agent runs). Refresh via build-crawled-index.mjs.
  const crawledIndex = loadCrawledIndex();
  let totalThreads = 0;
  let totalCases = 0;

  for (const forum of ready) {
    if (pastDeadline()) {
      console.log('  ⏱ Window deadline reached — stopping crawl cleanly (remaining forums next run).');
      break;
    }
    console.log(`  Crawling: ${forum.name || forum.url}`);
    const calibration = safeJsonParse(forum.calibration_json);

    // ── Revive matured deferred threads ──
    // A thread set aside earlier as too-young (its newest post was <1yr old) is
    // re-queued once that year has passed, so this batch re-fetches it and can
    // capture a resolution that has landed since. This is the mechanism that
    // makes "set aside" reversible — a late fix is never permanently lost.
    const revived = state.reviveDueDeferredThreads(forum.id);
    if (revived > 0) console.log(`  Revived ${revived} matured deferred thread(s) for re-check.`);

    // ── Fill the archive queue (deep walk) ──
    // Walk the listing pages IN ORDER, marching deeper into the archive and
    // remembering where we stopped (per-section cursor), instead of re-reading
    // the newest threads. Only advance while the already-enqueued backlog is
    // low, so the pending queue stays bounded.
    let cursor = safeJsonParse(forum.archive_cursor_json);
    if (!cursor || !cursor.sections) cursor = { sections: {}, complete: false };
    const wasComplete = !!cursor.complete;
    const queueFloor = Math.max(opts.batchSize * 2, 20);
    let pendingCount = state.countPendingThreads(forum.id);

    let walk = null;
    try {
      if (!cursor.complete && pendingCount < queueFloor) {
        // Archive not fully mined yet → fetch the next pages and enqueue them.
        walk = await enumerateThreadUrlsDeep(forum, calibration, {
          cursor,
          pagesPerBatch: ARCHIVE_PAGES_PER_BATCH,
          sleepMs: opts.sleepMs,
        });
        cursor = walk.cursor;
        state.updateForum(forum.id, { archive_cursor_json: JSON.stringify(cursor) });

        // ── False-complete audit ──
        // A section is "done" the moment findNextPageLink returns null, so an
        // undetected pagination pattern silently declares a whole forum's
        // archive mined after ~1 page per section (seen on WoltLab/SMF:
        // RenaultForum 43 sections × 1 page). Completing with barely more
        // pages than sections is that signature — warn loudly instead of
        // parking the forum for 30 days in silence.
        if (cursor.complete && !wasComplete) {
          const secCount = Object.keys(cursor.sections || {}).length;
          const totalPages = Object.values(cursor.sections || {})
            .reduce((a, s) => a + (s?.pages || 0), 0);
          if (secCount > 0 && totalPages <= secCount + 2) {
            const msg = `archive marked complete after only ${totalPages} listing page(s) across ${secCount} section(s) — pagination likely undetected (false complete); check section_pagination_selector / findNextPageLink for this engine`;
            console.warn(`  ⚠ ${forum.url}: ${msg}`);
            state.log('warn', `${forum.url}: ${msg}`, 'crawl');
          }
        }
      } else if (cursor.complete && pendingCount === 0) {
        // Archive done → shallow head-scan for brand-new threads (the cherry).
        walk = await enumerateThreadUrlsDeep(forum, calibration, {
          cursor,
          pagesPerBatch: HEAD_SCAN_PAGES,
          headScan: true,
          sleepMs: opts.sleepMs,
        });
      }
    } catch (err) {
      if (isStoppingError(err)) throw err;
      console.error(`  Error walking archive for ${forum.url}: ${err.message}`);
    }

    // Enqueue freshly enumerated threads. Dedup against the cross-source index
    // + local non-pending rows BEFORE they ever reach the LLM.
    let enqueued = 0;
    let skippedByIndex = 0;
    if (walk) {
      for (const link of walk.links) {
        if (isThreadAlreadyExtracted(link.url, crawledIndex)) { skippedByIndex++; continue; }
        const existing = state.getThreadByUrl(link.url);
        if (existing && existing.status !== 'pending') continue;
        state.addThread({ forumId: forum.id, url: link.url, title: link.title || null });
        enqueued++;
      }
      pendingCount = state.countPendingThreads(forum.id);
      console.log(`  Archive walk: enumerated ${walk.links.length}, +${enqueued} queued, ${skippedByIndex} already known; ${pendingCount} pending${walk.complete ? ' (archive complete)' : ''}.`);
    }

    // ── Process a bounded batch from the pending queue (oldest first) ──
    const queue = state.getPendingThreads(opts.batchSize, forum.id);
    const processedUrls = [];
    let batchCases = 0;
    let deferredCount = 0;
    for (const t of queue) {
      if (pastDeadline()) {
        console.log('  ⏱ Window deadline reached — leaving remaining queued threads pending.');
        break;
      }
      const threadId = t.id;
      const url = t.url;
      processedUrls.push(url);
      totalThreads++;

      try {
        const result = await processThread(url, calibration, pipeline);

        if (result.deferred) {
          // Too young to judge yet — set aside until ~1yr after its last post
          // instead of discarding, so a resolution that lands later isn't lost.
          // We don't store thread_text here (it's re-fetched on revival): a busy
          // forum can defer thousands of threads and the body would bloat agent.db.
          state.updateThread(threadId, {
            status: 'deferred',
            revisit_after: result.revisitAfter,
            title: result.title || null,
          });
          deferredCount++;
          continue;
        }

        if (result.skipped) {
          // No thread_text on discards (mirrors the deferred path): nothing
          // ever reads it again — every consumer (verify, triage, audits)
          // reaches thread_text via cases, and discarded threads have none.
          // Storing it grew agent.db by ~5 MB/night (33 MB of dead text by
          // 2026-07). A later re-judge (recover/revive) re-fetches anyway.
          state.updateThread(threadId, {
            status: 'discarded',
            discard_reason: result.skipped,
            thread_text: null,
            title: result.title || null,
          });
          continue;
        }

        state.updateThread(threadId, {
          status: 'extracted',
          thread_text: result.threadText,
          title: result.title,
          // Clear any 'transient:' note left by a prior retry so it doesn't
          // pollute the diary's top-discard stats for a thread that succeeded.
          discard_reason: null,
        });

        // Save valid cases
        for (const { case: c, validation } of result.cases) {
          if (!validation.valid) continue;

          // Enrich payload with thread metadata
          c.thread_url = url;
          c.source_ref = c.source_ref || `agent:thread:${url}`;

          const caseId = createHash('sha256')
            .update([
              url,
              c.case_author || '',
              c.description || '',
              c.resolution || '',
              JSON.stringify(c.fault_post_numbers || []),
              JSON.stringify(c.resolution_post_numbers || []),
            ].join('|'))
            .digest('hex');

          state.addCase({ id: caseId, threadId, payload: c });
          totalCases++;
          batchCases++;
        }
      } catch (err) {
        if (isStoppingError(err)) throw err;  // quota/auth → stop the phase, don't bury the thread
        console.error(`  Error processing ${url}: ${err.message}`);
        // First transient failure (timeout, 5xx, connection reset) → leave the
        // thread pending so the next batch retries it once; repeated or
        // permanent failures bury it as 'error'.
        const current = state.getThread(threadId);
        const firstTransientFailure = isTransientCrawlerError(err) && !current?.discard_reason;
        state.updateThread(threadId, firstTransientFailure
          ? { status: 'pending', discard_reason: `transient: ${err.message}` }
          : { status: 'error', discard_reason: err.message });
      }

      await sleep(opts.sleepMs);
    }

    // ── Update forum stats + decide the next cooldown ──
    const crawled = state.countCrawledThreads(forum.id);
    const forumCases = state.countForumCases(forum.id);
    const remainingPending = state.countPendingThreads(forum.id);
    const crawledAt = new Date().toISOString();

    // A forum truly rests only once its WHOLE archive has been walked
    // (cursor.complete) AND the pending queue is drained — then it waits 30
    // days, after which a shallow head-scan picks up brand-new threads. Until
    // then it stays in rotation so successive batches march deeper.
    const archiveDone = cursor.complete && remainingPending === 0;
    const forumUpdate = {
      last_crawled_at: crawledAt,
      threads_crawled: crawled,
      new_threads_last_batch: enqueued,
      cases_total: forumCases,
    };
    if (archiveDone) {
      forumUpdate.status = 'exhausted';
      forumUpdate.cooldown_until = new Date(Date.now() + COOLDOWN_HOURS_EXHAUSTED * 3600_000).toISOString();
      forumUpdate.cooldown_tier_hours = COOLDOWN_HOURS_EXHAUSTED;
      forumUpdate.cooldown_set_at = crawledAt;
      console.log(`  ✓ Archive fully mined — resting ${forum.name || forum.url} for 30 days.`);
    } else {
      // Stay eligible: no long park while there is archive left to walk or a
      // backlog to drain.
      forumUpdate.status = 'active';
      forumUpdate.cooldown_until = null;
      forumUpdate.cooldown_tier_hours = null;
      forumUpdate.cooldown_set_at = null;
    }
    state.updateForum(forum.id, forumUpdate);
    console.log(`  Forum done: ${processedUrls.length} processed, +${batchCases} cases (total: ${crawled} threads, ${forumCases} cases; ${remainingPending} still queued).`);

    // Mirror last-scraped state to the online registry (best-effort; no-op
    // without a service key). This is what makes crawl_forums the shared
    // "last-scraped" list, not just a discovery ledger.
    await upsertForum({
      root_url: forum.url,
      name: forum.name,
      engine: forum.parser,
      language: forum.language,
      status: archiveDone ? 'exhausted' : 'active',
      threads_crawled: crawled,
      cases_total: forumCases,
      yield_rate: crawled > 0 ? forumCases / crawled : 0,
      last_crawled_at: crawledAt,
    }, { now: crawledAt }).catch(() => {});

    // ── Write LLM diary entry for this forum ──
    // Collect top discard reasons from the threads processed this batch.
    const discardReasons = [];
    for (const url of processedUrls) {
      const t = state.getThreadByUrl(url);
      if (t?.discard_reason) discardReasons.push(t.discard_reason);
    }
    const discardCounts = {};
    for (const r of discardReasons) discardCounts[r] = (discardCounts[r] ?? 0) + 1;
    const topDiscards = Object.entries(discardCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, n]) => `${r} (×${n})`);

    try {
      // Exclude deferred (too-young, set aside — no verdict) from the diary's
      // yield denominator, mirroring countCrawledThreads / the coach counters.
      await writeDiary(state, forum, { threads: processedUrls.length - deferredCount, cases: batchCases }, topDiscards);
    } catch (err) {
      if (isStoppingError(err)) throw err;
      logWarn(`Diary write skipped for ${forum.name || forum.url}: ${err.message}`);
    }
  }

  console.log(`  Batch done: ${totalThreads} threads processed, ${totalCases} cases extracted.`);
  return {
    threads_processed: totalThreads,
    cases_extracted: totalCases,
  };
}

// ---------------------------------------------------------------------------
// Phase: VERIFY — independent AI audit (L5)
// ---------------------------------------------------------------------------

async function phaseVerify(state, opts) {
  console.log('\n── Phase: VERIFY ──');

  let passed = 0;
  let rejected = 0;   // gate FAILs only (quality signal for verify_pass_rate)
  let errored = 0;    // transient errors — NOT a quality rejection
  let drained = false;

  // Drain the whole queue batch-by-batch (was: ONE batch per run). Verify
  // throughput was capped at batchSize/run ≈ 120/night while extraction makes
  // ~140/night — the ai_approved backlog grew without bound (260 cases by
  // 2026-07-02) and the night report said "verified: 0" for cases that passed
  // 1–2 nights later. Termination: every processed case changes status or
  // bumps its attempts past the retry limit, so the selection always shrinks.
  while (!pastDeadline()) {
    const cases = state.getCasesForVerification(opts.batchSize, VERIFY_RETRY_LIMIT);
    if (cases.length === 0) break;
    drained = true;
    console.log(`  Verifying ${cases.length} case(s) with the independent AI auditor...`);

    for (const c of cases) {
      if (pastDeadline()) break;
      const payload = JSON.parse(c.payload_json);
      state.updateCase(c.id, { verify_attempts: (c.verify_attempts ?? 0) + 1 });

      // Get original thread text
      const thread = state.getThread(c.thread_id);
      if (!thread?.thread_text) {
        console.log(`  ⊘ ${c.id}: no thread text available, skipping`);
        state.updateCase(c.id, { status: 'verify_skipped', review_note: 'No thread text' });
        continue;
      }

      try {
        const result = await verifyCase(thread.thread_text, payload, {
          timeoutMs: opts.verifyTimeoutMs || 120_000,
        });

        if (result.verdict === 'PASS') {
          state.updateCase(c.id, { status: 'verified', review_note: 'Verifier: PASS' });
          passed++;
          console.log(`  ✓ ${c.id}`);
        } else {
          state.updateCase(c.id, { status: 'verify_rejected', review_note: `Verifier: ${result.reason}` });
          rejected++;
          console.log(`  ✗ ${c.id}: ${result.reason}`);
        }
      } catch (err) {
        if (isStoppingError(err)) throw err;  // quota/auth → stop the phase
        state.updateCase(c.id, { status: 'verify_error', review_note: `Error: ${err.message}` });
        errored++;
        console.error(`  ✗ ${c.id}: error — ${err.message}`);
      }

      await sleep(1000); // Brief pause between verifier calls
    }
  }

  if (!drained) {
    console.log('  No cases pending verification.');
    return {};
  }
  console.log(`  Verification done: ${passed} passed, ${rejected} rejected, ${errored} errored.`);
  // cases_verify_rejected feeds the night report's true verify_pass_rate — the
  // report sums per-run throughput (what happened tonight) instead of the
  // created-that-night case cohort (which lags verify by 1–2 nights). Errors are
  // excluded: a transient failure is not a quality rejection.
  return { cases_verified: passed, cases_verify_rejected: rejected };
}

// ---------------------------------------------------------------------------
// Phase: CROSSCHECK — dedupe vs existing DB (L6)
// ---------------------------------------------------------------------------

async function phaseCrosscheck(state, opts) {
  console.log('\n── Phase: CROSSCHECK ──');

  let passed = 0;
  let dupes = 0;
  let errors = 0;
  let drained = false;

  // Drain the whole queue batch-by-batch — see phaseVerify for the rationale
  // (verify now drains, so crosscheck/import must keep up in the same run).
  while (!pastDeadline()) {
    const cases = state.getCasesForCrosscheck(opts.batchSize, CROSSCHECK_RETRY_LIMIT);
    if (cases.length === 0) break;
    drained = true;
    const { supabaseUrl, supabaseKey } = requireSupabaseConfig('read');

    for (const c of cases) {
      if (pastDeadline()) break;
      const payload = JSON.parse(c.payload_json);
      state.updateCase(c.id, { crosscheck_attempts: (c.crosscheck_attempts ?? 0) + 1 });

      const localDuplicates = state.getCasesForThread(c.thread_id, c.id)
        .filter(other => LOCAL_DUPLICATE_STATUSES.has(other.status))
        .some(other => isLikelyLocalDuplicate(payload, safeJsonParse(other.payload_json)));

      if (localDuplicates) {
        state.updateCase(c.id, {
          status: 'crosscheck_dupe',
          review_note: 'Duplicate of an existing local case for the same thread',
        });
        dupes++;
        continue;
      }

      try {
        const result = await crosscheckCaseAgainstSupabase({
          supabaseUrl,
          supabaseKey,
          payload,
        });

        if (result.status === 'error') {
          state.updateCase(c.id, {
            status: 'crosscheck_error',
            review_note: result.reviewNote,
          });
          errors++;
          console.error(`  Crosscheck query failed for ${c.id}: HTTP ${result.httpStatus}`);
          continue;
        }

        if (result.status === 'duplicate') {
          state.updateCase(c.id, { status: 'crosscheck_dupe', review_note: 'Duplicate resolution in Supabase' });
          dupes++;
          continue;
        }
      } catch (err) {
        state.updateCase(c.id, {
          status: 'crosscheck_error',
          review_note: `Crosscheck error: ${err.message}`,
        });
        errors++;
        console.error(`  Crosscheck query failed for ${c.id}: ${err.message}`);
        continue;
      }

      state.updateCase(c.id, { status: 'import_ready' });
      passed++;
    }
  }

  if (!drained) {
    console.log('  No verified cases pending crosscheck.');
    return {};
  }
  console.log(`  Crosscheck done: ${passed} ready for import, ${dupes} duplicates skipped, ${errors} errors held back.`);
  return {};
}

// ---------------------------------------------------------------------------
// Phase: IMPORT — push to Supabase
// ---------------------------------------------------------------------------

async function phaseImport(state, opts) {
  console.log('\n── Phase: IMPORT ──');

  let imported = 0;
  let failed = 0;
  let drained = false;

  // Drain the whole queue batch-by-batch — see phaseVerify for the rationale
  // (verify now drains, so import must keep up in the same run).
  while (!pastDeadline()) {
    const cases = state.getCasesForImport(opts.batchSize, IMPORT_RETRY_LIMIT);
    if (cases.length === 0) break;
    drained = true;
    const { supabaseUrl, supabaseKey } = requireSupabaseConfig('function');

    for (const c of cases) {
      if (pastDeadline()) break;
      const payload = JSON.parse(c.payload_json);
      state.updateCase(c.id, { import_attempts: (c.import_attempts ?? 0) + 1 });
      const normalizedDescription = normalizeImportText(payload.description || '');
      const normalizedResolution = normalizeImportText(payload.resolution || '');
      const importResolution = clampResolutionForImport(normalizedResolution);
      const sanitizationNote = importResolution !== normalizedResolution
        ? `Resolution trimmed for import (${normalizedResolution.length} → ${importResolution.length})`
        : null;

      if (importResolution.length < RESOLUTION_MIN_LENGTH) {
        state.updateCase(c.id, {
          status: 'import_failed',
          review_note: `Resolution too short for import after sanitization (${importResolution.length} < ${RESOLUTION_MIN_LENGTH})`,
        });
        failed++;
        console.log(`  ✗ ${c.id.slice(0, 8)}: resolution too short`);
        continue;
      }

      try {
        // Inline canonicalization: new imports get the catalog's exact brand spelling
        // (casing/diacritics/alias), so they are discoverable in the app from the start
        // (search filters vehicle_brand by exact match). Model-level gaps stay as-is and
        // are handled by the Phase-2 catalog-proposal flow, not silently remapped.
        const _rawBrand = payload.vehicle_brand || payload.brand_raw || '';
        const _veh = resolveVehicle({ vehicle_brand: _rawBrand, vehicle_model: payload.vehicle_model || payload.model_raw || '' });
        const vehicleBrandCanonical = _veh.matched ? _veh.canonicalBrand : _rawBrand;
        const res = await fetch(`${supabaseUrl}/functions/v1/push-case`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({
            local_id: c.id,
            user_id: 'ai_importer',
            vehicle_brand: vehicleBrandCanonical,
            vehicle_model: payload.vehicle_model || payload.model_raw || '',
            engine_power: payload.engine_power || payload.engine_raw || '',
            symptoms: payload.symptoms || [],
            obd_codes: payload.obd_codes || [],
            description: normalizedDescription,
            resolution: importResolution,
            source_ref: payload.source_ref || `agent:${c.id.slice(0, 12)}`,
            thread_url: payload.thread_url || payload.source_url || '',
          }),
        });

        if (res.ok) {
          state.updateCase(c.id, {
            status: 'imported',
            review_note: sanitizationNote ? `Pushed to Supabase. ${sanitizationNote}` : 'Pushed to Supabase',
          });
          imported++;
          console.log(`  ✓ ${c.id.slice(0, 8)}`);
        } else {
          const errBody = await res.text().catch(() => '');
          state.updateCase(c.id, { status: 'import_failed', review_note: `HTTP ${res.status}: ${errBody.slice(0, 200)}` });
          failed++;
          console.log(`  ✗ ${c.id.slice(0, 8)}: HTTP ${res.status}`);
        }
      } catch (err) {
        state.updateCase(c.id, { status: 'import_failed', review_note: `Error: ${err.message}` });
        failed++;
        console.error(`  ✗ ${c.id.slice(0, 8)}: ${err.message}`);
      }

      await sleep(500);
    }
  }

  if (!drained) {
    console.log('  No cases ready for import.');
    return {};
  }
  console.log(`  Import done: ${imported} imported, ${failed} failed.`);
  return { cases_imported: imported };
}

// ---------------------------------------------------------------------------
// Pipeline builder
// ---------------------------------------------------------------------------

function buildCalibrationPipeline(opts) {
  return createCrawlPipeline({ sleepMs: opts.sleepMs });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJsonParse(str) {
  try { return JSON.parse(str || '{}') || {}; } catch { return {}; }
}

function loadForumCandidates() {
  try {
    const path = new URL('./forum-candidates.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(parsed)
      ? parsed.slice().sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999))
      : [];
  } catch (err) {
    logWarn(`Could not load forum candidates: ${err.message}`);
    return [];
  }
}

function requireSupabaseConfig(kind) {
  const supabaseUrl = process.env.SUPABASE_URL || SUPABASE_DEFAULTS.url;
  const supabaseKey = kind === 'function'
    ? resolveSupabaseFunctionKey(process.env, SUPABASE_DEFAULTS)
    : resolveSupabaseReadKey(process.env, SUPABASE_DEFAULTS);
  if (!supabaseUrl || !supabaseKey) {
    const envName = kind === 'function'
      ? 'SUPABASE_SERVICE_KEY or SUPABASE_FUNCTION_KEY'
      : 'SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY';
    throw new Error(`Missing Supabase config for ${kind}: set SUPABASE_URL and ${envName}`);
  }
  return { supabaseUrl, supabaseKey };
}

function createEmptyRunStats() {
  return {
    threads_processed: 0,
    cases_extracted: 0,
    cases_verified: 0,
    cases_verify_rejected: 0,
    cases_imported: 0,
  };
}

function mergeRunStats(target, delta = {}) {
  for (const key of Object.keys(target)) {
    target[key] += delta[key] ?? 0;
  }
}

function normalizeCaseAuthor(value) {
  return (value ?? '').toString().trim().toLowerCase();
}

function isLikelyLocalDuplicate(payload, otherPayload) {
  const author = normalizeCaseAuthor(payload.case_author);
  const otherAuthor = normalizeCaseAuthor(otherPayload.case_author);
  if (author && otherAuthor && author === otherAuthor) return true;

  const resolution = normalizeForDedupe(payload.resolution);
  const otherResolution = normalizeForDedupe(otherPayload.resolution);
  return Boolean(resolution && otherResolution && resolution === otherResolution);
}

function formatLogTimestamp(value) {
  const text = (value ?? '').toString().trim();
  if (!text) return 'unknown-ts';
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const parsed = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function runOnce(state, opts) {
  const runId = state.startRun(opts.phase || 'full');
  const runStats = createEmptyRunStats();
  const before = {
    threads: Object.values(state.countThreadsByStatus()).reduce((a, b) => a + b, 0),
    cases: Object.values(state.countCasesByStatus()).reduce((a, b) => a + b, 0),
    imported: (state.countCasesByStatus().imported ?? 0),
  };

  let stopReason = null;
  let fatalError = null;
  try {
    const phases = opts.phase ? [opts.phase] : ['discover', 'calibrate', 'crawl', 'verify', 'crosscheck', 'import'];

    for (const phase of phases) {
      if (pastDeadline()) {
        console.log(`\n  ⏱ Window deadline reached — skipping remaining phases (they resume next run).`);
        break;
      }
      setLogPhase(phase);
      let phaseStats = null;
      switch (phase) {
        case 'discover':   phaseStats = await phaseDiscover(state, opts); break;
        case 'calibrate':  phaseStats = await phaseCalibrate(state, opts); break;
        case 'crawl':      phaseStats = await phaseCrawl(state, opts); break;
        case 'verify':     phaseStats = await phaseVerify(state, opts); break;
        case 'crosscheck': phaseStats = await phaseCrosscheck(state, opts); break;
        case 'import':     phaseStats = await phaseImport(state, opts); break;
        default:
          // A typo'd phase must fail loudly — a silent no-op would otherwise
          // count as a clean run and keep the stall heartbeat fresh forever.
          throw new Error(`Unknown phase: ${phase}`);
      }
      mergeRunStats(runStats, phaseStats ?? {});
    }
    setLogPhase(null);
  } catch (err) {
    setLogPhase(null);
    if (err instanceof QuotaError) {
      stopReason = err.message;
      // Log to DB first so it's persisted even if console output is lost
      state.log('error', err.message, 'quota');
      const pauseUntil = enterQuotaPause(state, err);
      state.log('info', `Paused until ${pauseUntil.toISOString()}`, 'quota');
      console.error(formatQuotaMessage(err, pauseUntil));
      process.exitCode = QUOTA_EXIT_CODE;
    } else if (err instanceof AuthError) {
      // No pause: re-auth needs a human. Leave a stop reason so the heartbeat
      // is skipped and runs keep failing fast → the stall alarm fires.
      stopReason = err.message;
      state.log('error', err.message, 'auth');
      console.error(`\n  ✗ ${err.message}\n  → Open a plain terminal, run \`claude\`, and log in. The agent resumes on the next run.\n`);
      process.exitCode = AUTH_EXIT_CODE;
    } else {
      stopReason = `error: ${err.message}`;
      fatalError = err;
      logError(`Run error: ${err.message}`);
    }
  }

  // Heartbeat means "the full pipeline ran healthy" — only refresh it on a
  // full run (the scheduled production task). Phase-limited / manual runs must
  // not keep the stall anchor fresh, or a stuck full task would never alarm.
  // Always clear an expired pause on any clean run.
  if (!stopReason) {
    if (!opts.phase) recordSuccessHeartbeat(state);
    clearQuotaPause(state);
  }

  // Compute actual deltas
  const after = {
    threads: Object.values(state.countThreadsByStatus()).reduce((a, b) => a + b, 0),
    cases: Object.values(state.countCasesByStatus()).reduce((a, b) => a + b, 0),
    imported: (state.countCasesByStatus().imported ?? 0),
  };
  runStats.threads_processed = Math.max(runStats.threads_processed, after.threads - before.threads, 0);
  runStats.cases_extracted = Math.max(runStats.cases_extracted, after.cases - before.cases, 0);
  runStats.cases_imported = Math.max(runStats.cases_imported, after.imported - before.imported, 0);

  state.finishRun(runId, runStats, stopReason);
  if (stopReason) runStats.stop_reason = stopReason;
  if (fatalError) throw fatalError;
  return runStats;
}

async function main() {
  const opts = parseArgs();
  const state = new AgentState(undefined, { readOnly: opts.stats || opts.diary });
  setLogState(state);

  if (opts.stats) {
    printStats(state);
    state.close();
    return;
  }

  if (opts.diary) {
    printDiaries(state);
    state.close();
    return;
  }

  // Usage-limit pause gate: subscription limits reset on their own, so a
  // paused agent exits immediately and resumes on a later scheduled run.
  const activePause = getActivePause(state);
  if (activePause) {
    console.log(`⏸ Agent paused until ${activePause.until.toISOString()} (${activePause.reason}). Exiting.`);
    state.close();
    return;
  }

  console.log('═══ DriveCodex Autonomous Crawl Agent ═══');
  console.log(`Batch size: ${opts.batchSize}, Sleep: ${opts.sleepMs}ms, Continuous: ${opts.continuous}`);

  // Forum seeding is handled in phaseDiscover (with domain-level dedup check)

  do {
    await runOnce(state, opts);

    if (opts.continuous) {
      // Respect an active usage-limit pause instead of hammering the provider
      let pause = getActivePause(state);
      if (pause) {
        console.log(`\n  ⏸ Paused until ${pause.until.toISOString()} (${pause.reason}). Sleeping...`);
        while ((pause = getActivePause(state))) {
          await sleep(Math.min(5 * 60_000, Math.max(pause.until - new Date(), 1000)));
        }
        console.log('  ▶ Limit window passed — resuming.');
      } else {
        console.log(`\n  Sleeping 60s before next batch...`);
        await sleep(60_000);
      }
    }
  } while (opts.continuous);

  printStats(state);
  state.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
