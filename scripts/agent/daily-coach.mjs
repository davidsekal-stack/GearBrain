/**
 * daily-coach.mjs — daily self-improvement loop for the crawl agent (Phase 1: OBSERVE + EMIT).
 *
 * Runs once per day AFTER the night crawl window, from a DEDICATED scheduled task
 * (DriveCodexDailyCoach, ~06:20, via run-coach-batch.ps1) — NOT from the 5-minute
 * crawl batch, because that batch only fires inside the 21:00–06:00 window and would
 * run the coach at the window START against an empty daytime lookback. It aggregates
 * the just-finished night into:
 *   1. a structured metrics time-series (local crawl_metrics table; durable source of
 *      truth for measuring how each metric evolves), and
 *   2. a plain-Czech daily report (logs/daily-coach-YYYY-MM-DD.md) — surfaced in the
 *      app's admin Analytics panel.
 * Both are also pushed best-effort to Supabase (crawl_metrics / crawl_daily_report).
 *
 * Phase 1 is OBSERVE-ONLY: it changes NO crawler knob and emits NO proposals.
 *
 * Correctness notes (post-review):
 *  - The lookback window is ANCHORED to the night boundary (most recent
 *    COACH_NIGHT_START_HOUR, default 21:00 local — matches the crawl task's start),
 *    NOT a rolling Date.now()-Nh, so it captures the whole night whenever it runs.
 *  - The funnel + ratios are computed from ONE cohort (threads/cases created in the
 *    window), so verify_pass_rate etc. never mix started_at vs created_at cohorts.
 *  - A degenerate night (quota/auth stop anywhere in the window, or an empty window)
 *    writes an informational report but does NOT stamp the once-per-day key, so a
 *    later/again invocation can re-evaluate once real data exists.
 *
 * Usage:
 *   node --experimental-sqlite daily-coach.mjs [--force] [--dry-run]
 */

import { writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AgentState } from './state.mjs';
import { failingCondition } from './recall-watchdog.mjs';
import { planNight, alignNights, addDays, DEFAULT_CONFIG } from './coach-adapt.mjs';

// Per-forum night metrics recorded for the Phase 2 multi-night signal.
const PER_FORUM_METRICS = ['forum_good', 'forum_rejected', 'forum_processed', 'forum_extracted', 'forum_transient', 'forum_too_few'];

/** Phase 2 thresholds with optional env overrides (COACH_<KEY>). */
function buildAdaptConfig() {
  const c = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(c)) {
    const v = parseFloat(process.env[`COACH_${k}`] ?? '');
    if (Number.isFinite(v)) c[k] = v;
  }
  return c;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const COACH_NIGHT_START_HOUR = intEnv('COACH_NIGHT_START_HOUR', 21); // crawl window start (local); window = [this, now]
const COACH_HOUR     = intEnv('COACH_HOUR', 6);   // closed morning gate start (local)
const COACH_HOUR_END = intEnv('COACH_HOUR_END', 21); // closed morning gate end (exclusive)
const META_DATE      = 'coach_last_date';
const META_SUCCESS   = 'coach_last_success_at';

// Cases that have PASSED the verify gate (verified and everything downstream of it).
// Used for the GLOBAL funnel (cases_verified) — "passed verification" in the broad sense.
const VERIFY_PASSED = new Set(['verified', 'import_ready', 'imported', 'import_failed', 'crosscheck_dupe']);

// Narrowed set for the PER-FORUM quality signal that feeds Phase 2 priority/cooldown:
// only genuine new precision survivors. crosscheck_dupe (a duplicate of an existing
// case) and import_failed (transient import error) are excluded — they are not new
// good cases and must not inflate a forum's verified yield.
const FORUM_GOOD = new Set(['verified', 'import_ready', 'imported']);

/** A thread whose outcome reflects a transient failure (network/HTTP/timeout), not the forum's real productivity. */
function isTransientThread(t) {
  return t.status === 'error' || bucketDiscardReason(t.discard_reason) === 'transient';
}

function intEnv(name, dflt) { const v = parseInt(process.env[name] ?? '', 10); return Number.isFinite(v) ? v : dflt; }

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** Bucket a thread discard_reason into a small stable set. */
export function bucketDiscardReason(reason) {
  const r = (reason || '').toString().toLowerCase();
  if (!r) return 'other';
  if (r.includes('too few posts')) return 'too_few_posts';
  if (r.includes('classifier rejected')) return 'classifier_reject';
  if (r.includes('extractor returned no cases') || r.includes('no cases')) return 'extractor_empty';
  if (r.startsWith('transient') || r.includes('http 4') || r.includes('http 5') || r.includes('timeout')) return 'transient';
  return 'other';
}

/** UTC 'YYYY-MM-DD HH:MM:SS' = start of the most recent night window (local nightStartHour). */
export function nightCutoffUtc(now, nightStartHour = COACH_NIGHT_START_HOUR) {
  const start = new Date(now.getTime());
  if (now.getHours() < nightStartHour) start.setDate(start.getDate() - 1); // before tonight's start → last night
  start.setHours(nightStartHour, 0, 0, 0);
  return start.toISOString().slice(0, 19).replace('T', ' ');
}

/** Should the coach run now? Closed morning window + once-per-day. --force bypasses this upstream. */
export function gateDecision(now, { lastDate, today, hourStart = COACH_HOUR, hourEnd = COACH_HOUR_END } = {}) {
  const h = now.getHours();
  if (h < hourStart || h >= hourEnd) return { run: false, reason: `mimo ranní okno (${hourStart}:00–${hourEnd}:00)` };
  if (lastDate === today) return { run: false, reason: 'už dnes proběhlo' };
  return { run: true, reason: '' };
}

/** A night that must NOT move metrics: quota/auth stop anywhere in the window, or an empty window. */
export function detectDegenerate({ runs = [], threads = [], cases = [] } = {}) {
  const bad = runs.find(r => /quota|auth|limit/i.test((r.stop_reason || '').toString()));
  if (bad) return `Noční běh skončil předčasně (${bad.stop_reason}).`;
  if (runs.length === 0 && threads.length === 0 && cases.length === 0) return 'V okně neproběhl žádný crawl (prázdná noc).';
  return null;
}

const EMPTY_AGG = { metrics: {}, byForum: [], rejectConditions: {}, discardBuckets: {}, statusHist: {} };

/**
 * Aggregate the night from ONE cohort: threads PROCESSED in the window
 * (last_processed_at) and cases CREATED in it. Pure. Both cohorts now track the
 * same work — a thread re-processed tonight is counted even if it was discovered
 * long ago — so yield (cases ÷ processed) reflects real per-thread conversion,
 * not a created_at artifact. `cases` rows carry forum_id (joined in the reader).
 */
export function aggregateNight({ threads = [], cases = [], forums = [], runs } = {}) {
  // 'deferred' = fetched but set aside as too-young; like 'pending' it is not a
  // real verdict, so it must not count as processed (else a forum that merely
  // defers young threads looks "busy but barren" and triggers a false recal).
  const threadsProcessed = threads.filter(t => t.status && t.status !== 'pending' && t.status !== 'deferred').length;

  const discardBuckets = {};
  let discardedTotal = 0;
  for (const t of threads) {
    if (t.status !== 'discarded') continue;
    discardedTotal++;
    const b = bucketDiscardReason(t.discard_reason);
    discardBuckets[b] = (discardBuckets[b] || 0) + 1;
  }

  const statusHist = {};
  const rejectConditions = {};
  // Cohort-based fallbacks (used only when no `runs` are supplied, e.g. a
  // standalone call): status of cases CREATED this window, read now.
  let cohortVerifyPassed = 0, cohortVerifyRejected = 0, cohortImported = 0;
  for (const c of cases) {
    statusHist[c.status] = (statusHist[c.status] || 0) + 1;
    if (VERIFY_PASSED.has(c.status)) cohortVerifyPassed++;
    if (c.status === 'imported') cohortImported++;
    if (c.status === 'verify_rejected') {
      cohortVerifyRejected++;
      const cond = failingCondition(c.review_note);
      rejectConditions[cond] = (rejectConditions[cond] || 0) + 1;
    }
  }
  const casesExtracted = cases.length;

  // Verify/import THROUGHPUT — what actually happened this night. Sourced from
  // the runs table (per-run counters), NOT the created-tonight case cohort:
  // verify/import lag extraction by 1–2 nights, so the cohort reported
  // "verified: 0" on nights that in fact verified+imported ~120 cases, and made
  // yield_rate blow past 100 % on catch-up nights. When `runs` is omitted the
  // function falls back to the cohort so it stays usable standalone.
  const useRuns = Array.isArray(runs);
  let verifyPassed, verifyRejected, imported;
  if (useRuns) {
    const sum = (k) => runs.reduce((a, r) => a + (r[k] || 0), 0);
    verifyPassed = sum('cases_verified');
    verifyRejected = sum('cases_verify_rejected');
    imported = sum('cases_imported');
  } else {
    verifyPassed = cohortVerifyPassed;
    verifyRejected = cohortVerifyRejected;
    imported = cohortImported;
  }

  // Per-forum night stats over the UNION of forums seen in threads OR cases, so a
  // busy-but-barren forum (threads processed, zero cases) still emits explicit zeros
  // — the Phase 2 multi-night series must be dense and date-aligned to be trustworthy.
  const forumName = new Map(forums.map(f => [f.id, f.name || f.url || f.id]));
  const byForumRaw = {};
  const ensureForum = (fid) => byForumRaw[fid] ||
    (byForumRaw[fid] = { good: 0, rejected: 0, processed: 0, extracted: 0, transient: 0, tooFew: 0 });
  for (const t of threads) {
    if (!t.forum_id) continue;
    const e = ensureForum(t.forum_id);
    if (isTransientThread(t)) e.transient++;            // includes pending-with-transient-reason
    else if (t.status && t.status !== 'pending' && t.status !== 'deferred') e.processed++; // reached a real (non-transient) verdict
    if (bucketDiscardReason(t.discard_reason) === 'too_few_posts') e.tooFew++;
  }
  for (const c of cases) {
    if (!c.forum_id) continue;
    const e = ensureForum(c.forum_id);
    e.extracted++;
    if (FORUM_GOOD.has(c.status)) e.good++;
    else if (c.status === 'verify_rejected') e.rejected++;
  }
  const byForum = Object.entries(byForumRaw)
    .map(([fid, v]) => ({ forum: forumName.get(fid) || fid, forumId: fid, ...v }))
    .sort((a, b) => b.good - a.good || b.rejected - a.rejected);

  const ratio = (n, d) => (d > 0 ? +(n / d).toFixed(3) : 0);
  const metrics = {
    threads_processed: threadsProcessed,
    cases_extracted: casesExtracted,
    cases_verified: verifyPassed,
    cases_imported: imported,
    threads_discarded: discardedTotal,
    verify_rejected: verifyRejected,
    yield_rate: ratio(casesExtracted, threadsProcessed),
    verify_pass_rate: ratio(verifyPassed, verifyPassed + verifyRejected),
    // Funnel step AFTER verify (crosscheck survival), so numerator/denominator
    // share the runs cohort — was imported/casesExtracted, which mixed the runs
    // throughput with the created-tonight cohort and could exceed 100 %.
    import_rate: ratio(imported, verifyPassed),
  };
  for (const [b, n] of Object.entries(discardBuckets)) metrics[`discarded:${b}`] = n;
  for (const [c, n] of Object.entries(rejectConditions)) metrics[`verify_reject:${c}`] = n;

  return { metrics, byForum, rejectConditions, discardBuckets, statusHist };
}

const DISCARD_LABEL = {
  too_few_posts: 'málo příspěvků',
  classifier_reject: 'zamítl klasifikátor',
  extractor_empty: 'extraktor nic nevytěžil',
  transient: 'dočasná chyba (síť/blok)',
  other: 'jiné',
};

/** One plain-Czech bullet describing an applied auto change. */
function adaptBullet(d) {
  const s = d.signal || {};
  if (d.knob === 'priority') {
    const verb = d.direction === 'up' ? 'zvýšil' : 'snížil';
    const trend = d.direction === 'up'
      ? `stabilně dodává ověřené případy (${s.good} dobrých z ${s.processed} zpracovaných za ${s.nights} noci)`
      : `málo ověřených případů na vynaloženou práci (${s.good} z ${s.processed} za ${s.nights} noci)`;
    const place = d.direction === 'up' ? 'navštíví dřív' : 'půjde ve frontě níž';
    return `**${d.forumName}**: ${verb} jsem prioritu z ${s.current} na ${d.newFields.priority_score} — ${trend}. Crawler ho ${place}.`;
  }
  // Phase 2 cooldown moves are exactly one engine tier (168h⇄24h), so phrase them directly.
  if (d.direction === 'shorten') {
    return `**${d.forumName}**: zkrátil jsem čekání mezi návštěvami ze 7 dnů na 1 den — poslední noci slušně těžil (${s.good} dobrých). Vrátím se k němu dřív.`;
  }
  return `**${d.forumName}**: prodloužil jsem čekání z 1 dne na 7 dnů — dvě vyhodnocené noci po sobě nepřinesl ani jeden ověřený případ (a nešlo o výpadky sítě).`;
}

/** One plain-Czech bullet for a SHADOW re-calibration proposal (nothing was changed). */
function proposalBullet(p) {
  const s = p.signal || {};
  return `**${p.forumName}**: za ${s.nights} noci se zpracovalo ${s.processed} vláken, ale nevytěžilo se ani jeden případ — nejspíš se změnilo rozložení stránek fóra. Zvaž ruční re-kalibraci.`;
}

/** The "Co jsem automaticky upravil" report section. Pure. */
export function buildAdaptSection(plan, maxActions = DEFAULT_CONFIG.MAX_ACTIONS_PER_NIGHT) {
  const L = ['## Co jsem automaticky upravil'];
  if (plan.circuitTripped) {
    L.push('⚠️ Najednou by se měnila víc než polovina sledovaných fór — vypadá to spíš na chybu v datech než na skutečný vývoj, takže jsem pro jistotu NEPROVEDL žádnou automatickou úpravu.');
  } else if (plan.applied.length === 0) {
    L.push('_Dnes jsem neprovedl žádnou automatickou úpravu — buď byla data slabá, signál se neudržel přes víc nocí, nebo byla fóra v pořádku._');
  } else {
    for (const d of plan.applied) L.push('- ' + adaptBullet(d));
    if (plan.capHit) L.push(`_Dosáhl jsem denního limitu ${maxActions} úprav; zbytek nechávám na zítra._`);
  }
  if (plan.proposals.length > 0) {
    L.push('', '### Možná potřebují ruční kontrolu struktury', '_(NEZASAHOVAL jsem — jen upozorňuji, prohlédni prosím ručně.)_');
    for (const p of plan.proposals) L.push('- ' + proposalBullet(p));
  }
  L.push('', '_Fáze 2: měním jen pořadí ve frontě a načasování návštěv fór. Nikdy nesahám na prahy kontroly kvality ani na to, co projde do fronty ke schválení. Vše je v deníku (coach_journal) a vratné příkazem `apply-proposal.mjs --revert`._');
  return L;
}

/** Build the plain-Czech daily report (markdown). Pure. */
export function buildReport(agg, { date, windowLabel, degenerate = null, plan = null, maxActions = DEFAULT_CONFIG.MAX_ACTIONS_PER_NIGHT } = {}) {
  const m = agg.metrics;
  const L = [];
  L.push(`# Noční report crawleru — ${date}`, '');
  if (degenerate) {
    L.push(`⚠️ ${degenerate}`, '', 'Dnes nevyhodnocuju (neúplná noc), aby jeden špatný běh nezkreslil statistiky.');
    return L.join('\n');
  }
  L.push(`_Okno: ${windowLabel}._`, '');

  L.push('## Co se vytěžilo');
  L.push(`- Zpracovaná vlákna: **${m.threads_processed}**`);
  L.push(`- Vytěžené případy: **${m.cases_extracted}** (výnos ${(m.yield_rate * 100).toFixed(0)} %)`);
  L.push(`- Prošlo verifikací: **${m.cases_verified}** (úspěšnost ${(m.verify_pass_rate * 100).toFixed(0)} %)`);
  L.push(`- Naimportováno do fronty ke schválení: **${m.cases_imported}**`, '');

  L.push('## Proč to padalo');
  if (m.threads_discarded > 0) {
    L.push(`Zahozená vlákna: **${m.threads_discarded}**`);
    for (const [b, n] of Object.entries(agg.discardBuckets).sort((a, b2) => b2[1] - a[1])) {
      L.push(`  - ${DISCARD_LABEL[b] || b}: ${n}`);
    }
  } else {
    L.push('Žádná zahozená vlákna v okně.');
  }
  if (m.verify_rejected > 0) {
    L.push(`Zamítl verifikátor: **${m.verify_rejected}**`);
    for (const [c, n] of Object.entries(agg.rejectConditions).sort((a, b2) => b2[1] - a[1])) {
      L.push(`  - ${c}: ${n}`);
    }
  }
  L.push('');

  const forumsWithCases = agg.byForum.filter(f => f.good > 0 || f.rejected > 0);
  if (forumsWithCases.length > 0) {
    L.push('## Po fórech (dobré / zamítnuté)');
    for (const f of forumsWithCases.slice(0, 10)) L.push(`- ${f.forum}: ${f.good} ✓ / ${f.rejected} ✕`);
    L.push('');
  }

  L.push('---');
  if (plan) {
    for (const line of buildAdaptSection(plan, maxActions)) L.push(line);
  } else {
    L.push('_Zatím jen sleduji a měřím._');
  }
  return L.join('\n');
}

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Best-effort Supabase push (store-only; app reads it from there) ──────────

async function pushToSupabase(date, agg, reportMd) {
  const URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { ok: false, reason: 'no Supabase credentials' };
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
  try {
    const rows = Object.entries(agg.metrics).map(([metric, value]) => ({ date, scope: 'global', metric, value }));
    let mRes = { ok: true };
    if (rows.length > 0) {
      mRes = await fetch(`${URL}/rest/v1/crawl_metrics?on_conflict=date,scope,metric`, {
        method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows),
      });
    }
    const rRes = await fetch(`${URL}/rest/v1/crawl_daily_report?on_conflict=date`, {
      method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([{ date, report_md: reportMd, metrics_json: agg.metrics }]),
    });
    if (!mRes.ok || !rRes.ok) return { ok: false, reason: `metrics ${mRes.status ?? 'ok'} / report ${rRes.status} (tables may not exist yet)` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ── Phase 2 adapt (auto-tier: priority + cooldown apply, re-calibration shadow) ──

/** Record global + per-forum night metrics. The per-forum series feed the planner. */
function recordPerForumMetrics(state, today, agg) {
  for (const [metric, value] of Object.entries(agg.metrics)) state.recordMetric(today, metric, value);
  for (const f of agg.byForum) {
    state.recordMetric(today, 'forum_good', f.good, f.forumId);
    state.recordMetric(today, 'forum_rejected', f.rejected, f.forumId);
    state.recordMetric(today, 'forum_processed', f.processed, f.forumId);
    state.recordMetric(today, 'forum_extracted', f.extracted, f.forumId);
    state.recordMetric(today, 'forum_transient', f.transient, f.forumId);
    state.recordMetric(today, 'forum_too_few', f.tooFew, f.forumId);
  }
}

/** Per-forum aligned night series, with tonight overlaid (accurate in --dry-run; idempotent live). */
function buildNightsByForum(state, forums, agg, today) {
  const tonight = new Map(agg.byForum.map(f => [f.forumId, f]));
  const out = {};
  for (const f of forums) {
    const series = {};
    for (const m of PER_FORUM_METRICS) series[m] = state.getMetricSeries(m, f.id, 120);
    let nights = alignNights(series);
    const t = tonight.get(f.id);
    if (t) {
      nights = nights.filter(n => n.date !== today);
      nights.push({ date: today, good: t.good, rejected: t.rejected, processed: t.processed, extracted: t.extracted, transient: t.transient, tooFew: t.tooFew });
      nights.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }
    out[f.id] = nights;
  }
  return out;
}

function computePlan(state, forums, agg, now, today, config) {
  const nightsByForum = buildNightsByForum(state, forums, agg, today);
  const lockSince = addDays(today, -config.COOLDOWN_REVERSE_LOCK_DAYS);
  const journalByForum = {};
  for (const f of forums) journalByForum[f.id] = state.getRecentCoachCooldownChanges(f.id, lockSince);
  const alreadyChanged = new Set(
    state.getCoachJournalForDate(today).filter(r => Number(r.applied) === 1).map(r => r.forum_id)
  );
  return planNight({ forums, nightsByForum, journalByForum, alreadyChangedForumIds: alreadyChanged, now, todayStr: today, config });
}

function applyPlan(state, today, plan) {
  for (const d of plan.applied) {
    const res = state.applyCoachChange({
      date: today, forumId: d.forumId, forumName: d.forumName, knob: d.knob,
      direction: d.direction, reasonCode: d.reasonCode, signal: d.signal,
      oldFields: d.oldFields, newFields: d.newFields,
    });
    if (res.ok) state.log('info', `coach ${d.knob} ${d.direction} ${d.forumName}: ${JSON.stringify(d.oldFields)} → ${JSON.stringify(d.newFields)} (${d.reasonCode})`, 'coach');
    else state.log('warn', `coach skipped ${d.knob} on ${d.forumName}: ${res.reason}`, 'coach');
  }
  for (const p of plan.proposals) {
    state.recordCoachProposal({ date: today, forumId: p.forumId, forumName: p.forumName, knob: p.knob, reasonCode: p.reasonCode, signal: p.signal });
    state.log('warn', `coach proposal recalibrate ${p.forumName} (${p.reasonCode}; ${JSON.stringify(p.signal)})`, 'coach');
  }
  if (plan.circuitTripped) state.log('warn', `coach circuit breaker: ${plan.deferred.length}/${plan.evaluable} forums would change — applied none`, 'coach');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  const config = buildAdaptConfig();

  const now = new Date();
  const today = localDateStr(now);
  const state = new AgentState();

  try {
    if (!force) {
      const gate = gateDecision(now, { lastDate: state.getMeta(META_DATE), today });
      if (!gate.run) { console.log(`daily-coach: skipping — ${gate.reason}.`); return; }
    }

    const cutoff = nightCutoffUtc(now);
    const runs = state.getRunsSince(cutoff);
    // Window on WORK done tonight (last_processed_at), not on discovery date —
    // otherwise archive re-processing of old threads is invisible and yield_rate
    // (cases ÷ threads) blows past 100 % whenever the night mines the archive.
    const threads = state.getThreadsProcessedSince(cutoff);
    const cases = state.getCasesCreatedSince(cutoff);
    const forums = state.getAllForums();

    const degenerate = detectDegenerate({ runs, threads, cases });
    const agg = degenerate ? EMPTY_AGG : aggregateNight({ threads, cases, forums, runs });

    // Record metrics BEFORE planning so the multi-night series include tonight.
    // Real night only, never in --dry-run.
    if (!degenerate && !dryRun) recordPerForumMetrics(state, today, agg);

    // Phase 2 auto-tier: plan + (live only) apply. Degenerate night → no adapt at all.
    let plan = null;
    if (!degenerate) {
      plan = computePlan(state, forums, agg, now, today, config);
      if (!dryRun) applyPlan(state, today, plan);
    }

    const windowLabel = `${cutoff.slice(0, 16)} → ${now.toISOString().slice(0, 16)} UTC (noční běh)`;
    const reportMd = buildReport(agg, { date: today, windowLabel, degenerate, plan, maxActions: config.MAX_ACTIONS_PER_NIGHT });

    console.log(`daily-coach: ${today} cutoff=${cutoff} runs=${runs.length} threads=${threads.length} cases=${cases.length}` +
      (degenerate ? ` DEGENERATE(${degenerate})` : ` metrics=${JSON.stringify(agg.metrics)}`) +
      (plan ? ` adapt=${plan.applied.length}applied/${plan.proposals.length}proposed${plan.circuitTripped ? '/CIRCUIT' : ''}` : ''));

    if (dryRun) { console.log('\n----- REPORT (dry-run, not written) -----\n' + reportMd); return; }

    // local report file (always — informational even on a degenerate night)
    const logDir = join(__dirname, 'logs');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, `daily-coach-${today}.md`), reportMd, 'utf8');

    if (!degenerate) state.setMeta(META_DATE, today); // claim the day only after a real evaluation

    const push = await pushToSupabase(today, agg, reportMd);
    console.log(`daily-coach: supabase push ${push.ok ? 'ok' : 'skipped (' + push.reason + ')'}`);

    state.setMeta(META_SUCCESS, now.toISOString()); // liveness heartbeat (the coach ran)
    state.log('info', `daily-coach ${degenerate ? 'degenerate' : 'report'} for ${today}` +
      (degenerate ? ` (${degenerate})` : ` (${Object.keys(agg.metrics).length} metrics, ${plan ? plan.applied.length : 0} auto-changes, ${plan ? plan.proposals.length : 0} proposals)`), 'coach');
  } finally {
    state.close();
  }
}

const invokedDirectly = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedDirectly) await main();
