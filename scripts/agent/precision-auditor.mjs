/**
 * precision-auditor.mjs — daily PRECISION audit of the independent verifier (Phase 3).
 *
 * Mirror of recall-watchdog.mjs in the OPPOSITE direction. The watchdog catches the
 * verifier wrongly REJECTING good cases (recall). This auditor samples recently
 * APPROVED cases (status verified/import_ready/imported) and independently re-judges
 * them with Claude against the SAME QUALITY_BAR, reporting the rate of WRONGLY-ACCEPTED
 * cases — bad cases that slipped THROUGH the gate into the live diagnostic DB.
 *
 * A false-ACCEPT (a bad case corrupting real diagnoses) is WORSE than a false-REJECT
 * (lost yield). So precision matters more than recall, and a healthy precision signal
 * is the PREREQUISITE before any later phase may LOOSEN a gate. Phase 3 is REPORT-ONLY:
 * it changes no gate and no knob.
 *
 * Four deliberate inversions vs the recall mirror (each fixes a real failure mode):
 *  1. FAIL-OPEN, not fail-closed: an unparseable verdict on an already-live case is a
 *     surfaced + re-asked COVERAGE GAP, never an implicit "accept upheld".
 *  2. Judges the CLAMPED IMPORTED artifact (what actually entered the DB) for imported
 *     cases — a case that passed on its full resolution but imported as vague garbage
 *     must not read "ok".
 *  3. The Desktop marker is gated on a MULTI-DAY POOLED rate (7d) PLUS a same-day
 *     CLUSTER-on-one-clause escalation — a single 12-case day can't tell clean from a
 *     small leak, and a per-day binary would be alarm-fatigue fuel.
 *  4. A SKEPTICAL inverted prompt that must NAME the failing clause (a-e), partially
 *     breaking the cross-interpretation correlation a verbatim re-ask would have
 *     (cross-VENDOR DeepSeek-vs-Claude does not buy cross-INTERPRETATION independence).
 *
 * Routing: registers AGENT_LLM_COACH-PRECISION (default claude:haiku) via the env
 * override, like recall-watchdog. Self-gates once/local-day in the closed morning
 * window. Runs as the 3rd step of run-coach-batch.ps1.
 *
 * Usage:
 *   node --experimental-sqlite precision-auditor.mjs [--force] [--sample N] [--days N] [--dry-run]
 */

import { writeFileSync, appendFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AgentState } from './state.mjs';
import { isStoppingError } from './quota.mjs';
import { QUALITY_BAR } from './quality-bar.mjs';
import { clampResolutionForImport, normalizeImportText } from './supabase-utils.mjs';
import { promptField, promptList } from './prompt-sanitize.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Route the precision-audit task to Claude (independent vendor from the DeepSeek
// verifier). Set BEFORE importing runLlm; env override wins over DEFAULT_ROUTES.
if (!process.env['AGENT_LLM_COACH-PRECISION']) {
  process.env['AGENT_LLM_COACH-PRECISION'] = 'claude:haiku';
}
const { runLlm } = await import('./llm.mjs');

// ── Tunables (env-overridable) ──────────────────────────────────────────────
const SAMPLE_SIZE  = intEnv('PRECISION_AUDIT_SAMPLE', 12);
const FRESH_SLICE  = intEnv('PRECISION_FRESH_SLICE', 4);   // newest imported (live-DB rows)
const RISK_SLICE   = intEnv('PRECISION_RISK_SLICE', 5);    // payload-heuristic riskiest
const RANDOM_SLICE = intEnv('PRECISION_RANDOM_SLICE', 3);  // unbiased backstop
const WINDOW_DAYS  = intEnv('PRECISION_AUDIT_DAYS', 4);
const EVAL_HOUR     = intEnv('PRECISION_AUDIT_HOUR', 6);
const EVAL_HOUR_END = intEnv('PRECISION_AUDIT_HOUR_END', 21);
const ALERT_RATE = floatEnv('PRECISION_ALERT_RATE', 0.15);
const ALERT_MIN  = intEnv('PRECISION_ALERT_MIN', 2);
const MIN_JUDGED = intEnv('PRECISION_MIN_JUDGED', 4);
const POOL_WINDOW_DAYS = intEnv('PRECISION_POOL_DAYS', 7);
const POOL_ALERT_MIN   = intEnv('PRECISION_POOL_MIN', 3);
const CLUSTER_MIN      = intEnv('PRECISION_CLUSTER_MIN', 2);
// Trend-aware pooled alarm (review 2026-07-02, point 5). The old pooled gate
// (ratio >= 15 %) fired EVERY day at the current ~40 % base rate and could never
// go quiet even as things improved — alarm fatigue. Now the pooled marker fires
// only when the 7-day rate is SEVERE in absolute terms, OR REGRESSES clearly
// above its own trailing baseline. A high-but-stable-or-improving rate lets the
// marker clear (the flagged-cases tool + gold session are the deliberate
// response), while a genuine relapse re-fires.
const SEVERE_RATE       = floatEnv('PRECISION_SEVERE_RATE', 0.30);
const REGRESSION_FACTOR = floatEnv('PRECISION_REGRESSION_FACTOR', 1.5);
const POOL_BASELINE_DAYS = intEnv('PRECISION_BASELINE_DAYS', 30);
const COVERAGE_CAP     = intEnv('PRECISION_COVERAGE_CAP', 500);
const RESOLUTION_SHORT_CHARS = intEnv('PRECISION_RES_SHORT', 220);
const AUDIT_TIMEOUT_MS = 90_000;
const AUDIT_MAX_TOKENS = 300;
const MAX_THREAD_CHARS = 60_000;

const META_KEY        = 'precision_audit_last_date';
const META_AUDITED_IDS = 'precision_audited_ids';
const ALERT_FILE  = join(__dirname, 'precision-alert.txt');
const LOG_DIR     = join(__dirname, 'logs');
const LABELS_FILE = join(LOG_DIR, 'precision-labels.jsonl');

// Cases that PASSED the gate and are (or are heading) into the live DB.
const APPROVED_STATUSES = new Set(['verified', 'import_ready', 'imported']);

function intEnv(name, dflt)   { const v = parseInt(process.env[name] ?? '', 10); return Number.isFinite(v) ? v : dflt; }
function floatEnv(name, dflt) { const v = parseFloat(process.env[name] ?? '');   return Number.isFinite(v) ? v : dflt; }

// ── Pure helpers (exported for tests) ───────────────────────────────────────

// Multi-vehicle bleed proxy: distinct car brands mentioned in description+resolution.
const BRAND_PATTERNS = [
  /\baudi\b/i, /\bbmw\b/i, /\bcitro[eë]n\b/i, /\bdacia\b/i, /\bford\b/i, /\bhyundai\b/i, /\bkia\b/i,
  /\bmercedes\b/i, /\bnissan\b/i, /\bopel\b/i, /\bpeugeot\b/i, /\brenault\b/i, /\b(škoda|skoda)\b/i,
  /\btesla\b/i, /\btoyota\b/i, /\b(volkswagen|vw)\b/i, /\bvolvo\b/i, /\bfiat\b/i, /\bmazda\b/i, /\bhonda\b/i,
];
function countDistinctBrands(text) {
  const t = ` ${text || ''} `;
  let n = 0;
  for (const re of BRAND_PATTERNS) if (re.test(t)) n++;
  return n;
}

/** Payload-only, deterministic risk heuristic (higher = more worth auditing). */
export function riskScore(payload = {}) {
  let s = 0;
  const resolution = (payload.resolution || '').toString().trim();
  if (resolution.length < RESOLUTION_SHORT_CHARS) s += 3;          // short = what the import clamp guts
  if (!Array.isArray(payload.resolution_post_numbers) || payload.resolution_post_numbers.length === 0) s += 2;
  if (!Array.isArray(payload.fault_post_numbers) || payload.fault_post_numbers.length === 0) s += 1;
  if (countDistinctBrands(`${payload.description || ''} ${payload.resolution || ''}`) >= 2) s += 2; // multi-vehicle bleed
  if (/\b(clean|additiv|flush|reset|reflash|emulat)/i.test(resolution)) s += 1; // allowlist edge categories
  return s;
}

/** Parse the auditor's JSON verdict. FAIL-OPEN: a parse failure is a COVERAGE GAP
 *  (parseFail=true), never an implicit clean accept and never a manufactured alarm. */
export function parsePrecisionVerdict(raw) {
  const text = (raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { parseFail: true, wronglyAccepted: false, failedCondition: 'none', reason: 'unparseable' };
  try {
    const o = JSON.parse(text.slice(start, end + 1));
    return {
      wronglyAccepted: o.wrongly_accepted === true,
      confidence: typeof o.confidence === 'string' ? o.confidence : 'unknown',
      failedCondition: /^[a-e]$/.test(o.failed_condition) ? o.failed_condition : 'none',
      reason: (typeof o.reason === 'string' ? o.reason : '').slice(0, 200),
    };
  } catch {
    return { parseFail: true, wronglyAccepted: false, failedCondition: 'none', reason: 'unparseable' };
  }
}

/** Build the skeptical, clause-naming re-check prompt. For imported cases it shows the
 *  CLAMPED artifact actually stored in the DB (not the raw payload). All interpolated
 *  case fields are sanitized (whitespace-collapsed + length-capped) against injection. */
export function buildPrecisionPrompt(threadText, caseObj, status) {
  const text = (threadText || '').length > MAX_THREAD_CHARS
    ? threadText.slice(0, MAX_THREAD_CHARS) + '\n[...truncated...]'
    : (threadText || '');
  const brand = promptField(caseObj.vehicle_brand || caseObj.brand_raw || '?', 80);
  const model = promptField(caseObj.vehicle_model || caseObj.model_raw || '?', 80);
  const engine = promptField(caseObj.engine_power || caseObj.engine_raw || '', 80);
  const imported = status === 'imported';
  // Imported: show the clamped stored artifact (already normalized). Otherwise sanitize the payload.
  const resolution = imported ? clampResolutionForImport(normalizeImportText(caseObj.resolution || '')) : promptField(caseObj.resolution);
  const description = promptField(caseObj.description);
  const resLabel = imported ? 'Resolution (as stored in the database)' : 'Resolution';
  return `An automated gate ACCEPTED the case below — it is either ALREADY in the live diagnostic database or queued to enter it, where a bad case corrupts real repair advice. Independently catch a MISTAKEN acceptance. Assume NOTHING the gate did is correct: treat the case as wrongly_accepted UNLESS you can POSITIVELY CONFIRM from the original thread that ALL of (a)-(e) hold.

${QUALITY_BAR}

EXTRACTED CASE (as accepted):
  Vehicle: ${brand} ${model} ${engine}
  Symptoms: ${promptList(caseObj.symptoms)}
  Description: ${description}
  ${resLabel}: ${resolution}

ORIGINAL THREAD:
---
${text}
---

Name the FIRST quality-bar clause the case fails (a, b, c, d or e), or "none" if it genuinely meets all of them. Respond with ONE JSON object, nothing else:
{"wrongly_accepted":false,"confidence":"low|medium|high","failed_condition":"a|b|c|d|e|none","reason":"<=20 words"}`;
}

/**
 * Pick the daily sample: FRESH-IMPORTED (newest live rows, window- and audit-independent),
 * RISK (highest riskScore, prefer unaudited), RANDOM (unbiased). Underfilled slices spill
 * so the budget is spent. Pure: pass `rng` for deterministic tests.
 */
export function selectSample(pool, importedNewest, auditedIds, opts = {}) {
  const { sample = SAMPLE_SIZE, fresh = FRESH_SLICE, risk = RISK_SLICE, random = RANDOM_SLICE, rng = Math.random } = opts;
  const audited = auditedIds instanceof Set ? auditedIds : new Set(auditedIds || []);
  const chosen = new Map();
  const count = (slice) => [...chosen.values()].filter(c => c.slice === slice).length;
  const add = (c, slice) => { if (c && !chosen.has(c.id) && chosen.size < sample) chosen.set(c.id, { ...c, slice }); };

  // 1) FRESH-IMPORTED — newest imported rows; ignores window + audit history.
  for (const c of (importedNewest || [])) { if (count('fresh') >= fresh) break; add(c, 'fresh'); }

  // 2) RISK — riskiest first, unaudited preferred.
  const byRisk = (pool || []).filter(c => !chosen.has(c.id))
    .map(c => ({ c, r: riskScore(c.payload), aud: audited.has(c.id) ? 1 : 0 }))
    .sort((a, b) => (a.aud - b.aud) || (b.r - a.r) || cmpCreatedDesc(a.c, b.c));
  for (const { c } of byRisk) { if (count('risk') >= risk) break; add(c, 'risk'); }

  // 3) RANDOM — uniform from the remainder, unaudited preferred.
  const remaining = (pool || []).filter(c => !chosen.has(c.id));
  const unaud = remaining.filter(c => !audited.has(c.id));
  const randPool = shuffle((unaud.length ? unaud : remaining).slice(), rng);
  for (const c of randPool) { if (count('random') >= random) break; add(c, 'random'); }

  // 4) SPILL — top up any unused budget (riskiest remaining first).
  for (const { c } of byRisk) { if (chosen.size >= sample) break; add(c, 'spill'); }
  for (const c of remaining)  { if (chosen.size >= sample) break; add(c, 'spill'); }
  return [...chosen.values()];
}

function cmpCreatedDesc(a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); }
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

/**
 * Decide whether to raise the Desktop marker. alert = pooledHit OR clusterHit.
 *  - clusterHit: today wrong>=min, judged>=minJudged, ratio>=rate, AND the flags cluster
 *    on one quality-bar clause (>=clusterMin) — the systematic-leak fingerprint.
 *  - pooledHit = severeHit OR regressionHit (trend-aware, so it can go quiet):
 *      severeHit: pooled wrong>=poolMin AND pooled ratio >= severeRate (absolute ceiling).
 *      regressionHit: pooled wrong>=poolMin AND pooled ratio>=rate AND pooled ratio
 *        >= regressionFactor × baseline ratio (the 30-day trailing rate) — a clear
 *        relapse above the forum's own norm.
 *  A high-but-stable/improving rate below severeRate and not regressing → NO pooled
 *  alarm, so the marker clears once the situation is understood and being worked.
 *  A per-day wrong>=min without cluster/pool is only a quieter report nudge.
 *  parseFail/errored rows are excluded from every denominator (can't manufacture an alarm).
 */
export function shouldAlertPrecision(todayResults, pooledStats = { wrong: 0, judged: 0 }, opts = {}) {
  const {
    rate = ALERT_RATE, min = ALERT_MIN, minJudged = MIN_JUDGED, poolMin = POOL_ALERT_MIN, clusterMin = CLUSTER_MIN,
    severeRate = SEVERE_RATE, regressionFactor = REGRESSION_FACTOR, baseline = null,
  } = opts;
  const judgedRows = (todayResults || []).filter(r => !r.parseFail && !r.errored);
  const wrongRows = judgedRows.filter(r => r.wronglyAccepted);
  const judged = judgedRows.length, wrong = wrongRows.length;
  const ratio = judged ? wrong / judged : 0;

  const clauseCounts = {};
  for (const r of wrongRows) {
    const c = r.failedCondition || 'none';
    if (c !== 'none') clauseCounts[c] = (clauseCounts[c] || 0) + 1;
  }
  let clusterClause = null, clusterCount = 0;
  for (const [c, n] of Object.entries(clauseCounts)) if (n > clusterCount) { clusterClause = c; clusterCount = n; }

  const perDayNudge = wrong >= min && judged >= minJudged && ratio >= rate;
  const clusterHit = perDayNudge && clusterCount >= clusterMin;

  const pooledWrong = pooledStats.wrong || 0;
  const pooledJudged = pooledStats.judged || 0;
  const pooledRatio = pooledJudged ? pooledWrong / pooledJudged : 0;
  const baselineRatio = baseline && baseline.judged ? baseline.wrong / baseline.judged : 0;

  const severeHit = pooledWrong >= poolMin && pooledRatio >= severeRate;
  const regressionHit = pooledWrong >= poolMin && pooledRatio >= rate
    && baselineRatio > 0 && pooledRatio >= regressionFactor * baselineRatio;
  const pooledHit = severeHit || regressionHit;

  return {
    alert: pooledHit || clusterHit, clusterHit, pooledHit, severeHit, regressionHit, perDayNudge,
    wrong, judged, ratio, clusterClause, clusterCount,
    pooledWrong, pooledJudged, pooledRatio, baselineRatio,
    highConf: wrongRows.filter(r => r.confidence === 'high').length,
  };
}

// ── Local date helpers (copied — divergent from recall's, kept self-contained) ──
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function utcCutoff(days) { return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' '); }
function addLocalDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function intArg(args, flag, dflt) {
  const i = args.indexOf(flag);
  if (i === -1) return dflt;
  const v = parseInt(args[i + 1], 10);
  return Number.isFinite(v) ? v : dflt;
}

// ── Coverage ring buffer + pooled-label readers ─────────────────────────────

function loadAuditedIds(state) {
  try { const v = JSON.parse(state.getMeta(META_AUDITED_IDS) || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function saveAuditedIds(state, ids) {
  state.setMeta(META_AUDITED_IDS, JSON.stringify(ids.slice(-COVERAGE_CAP)));
}

/** Trailing-window pooled rate from the labelled judgements (the marker's primary signal). */
export function pooledStatsFrom(lines, today, days) {
  const cutoff = addLocalDays(today, -days); // EXCLUSIVE lower bound → a true trailing `days`-day window
  let wrong = 0, judged = 0;
  for (const line of lines) {
    const t = (line || '').trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      const d = o.date || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue; // only well-formed local dates compare correctly as strings
      if (d > cutoff) { judged++; if (o.wrongly_accepted) wrong++; }
    } catch { /* skip malformed */ }
  }
  return { wrong, judged };
}
function readLabelLines(path) {
  if (!existsSync(path)) return [];
  try { return readFileSync(path, 'utf8').split('\n'); } catch { return []; }
}

// ── Report ───────────────────────────────────────────────────────────────────

const CLAUSE_LABEL = {
  a: '(a) není osobní auto/dodávka/lehký pick-up', b: '(b) není skutečná oprava závady',
  c: '(c) konfigurace/upgrade/„spravilo se samo"', d: '(d) oprava neprovedena/nepotvrzena, nebo závadu/vozidlo nepopsal majitel',
  e: '(e) vozidlo neodpovídá citovaným příspěvkům',
};

function writeReport({ today, windowDays, poolSize, results, decision, unparsed, sliceCounts }) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const judged = decision.judged, wrong = decision.wrong;
  const pct = (x) => `${(x * 100).toFixed(0)} %`;
  const L = [];
  L.push(`# Kontrola přesnosti (precision audit) — ${today}`, '');
  L.push('_Vzorek = nejnovější schválené případy (podle času vytěžení); měříme, zda se do databáze nedostaly špatné případy._', '');

  if (poolSize === 0 && (results || []).length === 0) {
    L.push('Ve sledovaném okně nebyly žádné schválené případy ke kontrole.');
    writeFileSync(join(LOG_DIR, `precision-audit-${today}.md`), L.join('\n'), 'utf8');
    return;
  }

  if (decision.alert) {
    L.push(`⚠️ **Pozor:** z ${judged} překontrolovaných schválených případů jich nezávislá kontrola označila **${wrong}** (${pct(decision.ratio)}) jako pravděpodobně chybně schválené.`);
    if (decision.pooledJudged > 0) L.push(`Za posledních ${POOL_WINDOW_DAYS} dní: ${decision.pooledWrong} z ${decision.pooledJudged} (${pct(decision.pooledRatio)}).`);
  } else if (unparsed > judged && judged < MIN_JUDGED) {
    L.push(`Kontrola u **${unparsed}** případů nedoběhla (model nevrátil čitelný výsledek) — dnešní výsledek ber jako orientační.`);
  } else {
    L.push('Vše vypadá v pořádku — žádný jasně chybně schválený případ nad práh.');
  }
  if (decision.highConf > 0 && !decision.alert) {
    L.push(`_${decision.highConf} případ(ů) s vysokou jistotou označeno — prohlédni ručně (níže v tabulce ⚠️)._`);
  }
  if (decision.clusterCount >= CLUSTER_MIN) {
    L.push(`Většina nálezů (**${decision.clusterCount}**) padá na podmínku **${CLAUSE_LABEL[decision.clusterClause] || decision.clusterClause}** — možný systematický průsak celé třídy případů, prohlédni přednostně.`);
  }
  L.push('');
  L.push(`Souhrn: okno ${windowDays} dní · schválených v okně ${poolSize} · překontrolováno ${judged} · označeno ${wrong} · vysoká jistota ${decision.highConf} · nedoběhlo ${unparsed} · Alarm: ${decision.alert ? 'ANO' : 'ne'}`);
  L.push(`Vzorek: ${sliceCounts.fresh || 0} nejnovějších importů + ${sliceCounts.risk || 0} rizikových + ${sliceCounts.random || 0} náhodných${sliceCounts.spill ? ` (+${sliceCounts.spill} doplněno)` : ''}.`, '');

  const judgedRows = (results || []).filter(r => !r.parseFail && !r.errored);
  if (judgedRows.length > 0) {
    L.push('| případ | vozidlo | podmínka | jistota | nezávislá kontrola |', '|---|---|---|---|---|');
    for (const r of judgedRows.sort((a, b) => (b.wronglyAccepted ? 1 : 0) - (a.wronglyAccepted ? 1 : 0))) {
      const verdict = r.wronglyAccepted ? `⚠️ chybně schváleno — ${r.reason}` : `ok — ${r.reason || 'přijetí potvrzeno'}`;
      L.push(`| ${r.id.slice(0, 8)} | ${r.vehicle} | ${r.failedCondition !== 'none' ? r.failedCondition : '—'} | ${r.confidence} | ${verdict} |`);
    }
    L.push('');
  }
  const skipped = (results || []).filter(r => r.parseFail || r.errored);
  if (skipped.length > 0) {
    L.push('### Nedoběhlo (nezapočítává se do míry)');
    for (const r of skipped) L.push(`- ${r.id.slice(0, 8)} ${r.vehicle}: ${r.errored ? r.reason : 'model nevrátil čitelný výsledek'}`);
    L.push('');
  }
  L.push('---');
  L.push('_Fáze 3: jen měřím přesnost (kolik špatných případů prošlo do databáze). Nic neměním — je to podklad pro pozdější ladění bran. Štítky jsou strojový odhad (Claude), ne lidsky ověřený gold-set._');
  writeFileSync(join(LOG_DIR, `precision-audit-${today}.md`), L.join('\n'), 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function judgeCase(threadText, payload, status) {
  // One cheap re-ask on a parse failure before counting it a coverage gap.
  const prompt = buildPrecisionPrompt(threadText, payload, status);
  let raw = await runLlm('coach-precision', prompt, { timeoutMs: AUDIT_TIMEOUT_MS, maxTokens: AUDIT_MAX_TOKENS, temperature: 0 });
  let verdict = parsePrecisionVerdict(raw);
  if (verdict.parseFail) {
    raw = await runLlm('coach-precision', `${prompt}\n\nOutput ONLY the JSON object, nothing else.`, { timeoutMs: AUDIT_TIMEOUT_MS, maxTokens: AUDIT_MAX_TOKENS, temperature: 0 });
    verdict = parsePrecisionVerdict(raw);
  }
  return verdict;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  const sampleSize = intArg(args, '--sample', SAMPLE_SIZE);
  const windowDays = intArg(args, '--days', WINDOW_DAYS);

  const now = new Date();
  const today = localDateStr(now);
  const state = new AgentState();

  try {
    if (!force) {
      const h = now.getHours();
      if (h < EVAL_HOUR || h >= EVAL_HOUR_END) { console.log(`precision-auditor: mimo ranní okno (${EVAL_HOUR}:00–${EVAL_HOUR_END}:00) — skipping.`); return; }
      if (state.getMeta(META_KEY) === today) { console.log('precision-auditor: already ran today — skipping.'); return; }
    }

    // Pool = approved cases extracted in the window; FRESH source = newest imported (window-independent).
    const cutoff = utcCutoff(windowDays);
    const withPayload = (c) => { let p = {}; try { p = JSON.parse(c.payload_json); } catch { /* keep {} */ } return { ...c, payload: p }; };
    const pool = state.getCasesCreatedSince(cutoff)
      .filter(c => APPROVED_STATUSES.has(c.status))
      .map(withPayload);
    const importedNewest = state.getCasesByStatus('imported', 2000)
      .sort(cmpCreatedDesc)
      .slice(0, Math.max(FRESH_SLICE * 3, 12))
      .map(withPayload);

    const auditedIds = loadAuditedIds(state);
    let auditedSet = new Set(auditedIds);
    // If everything is already audited, reset coverage so a small DB keeps re-checking.
    if (pool.length > 0 && pool.every(c => auditedSet.has(c.id))) auditedSet = new Set();

    const sample = selectSample(pool, importedNewest, auditedSet, { sample: sampleSize });
    const sliceCounts = {};
    for (const s of sample) sliceCounts[s.slice] = (sliceCounts[s.slice] || 0) + 1;

    console.log(`precision-auditor: window=${windowDays}d approved=${pool.length} sampled=${sample.length} (${JSON.stringify(sliceCounts)})`);

    const results = [];
    const newAudited = [];
    for (const c of sample) {
      const vehicle = `${c.payload.vehicle_brand || c.payload.brand_raw || '?'} ${c.payload.vehicle_model || c.payload.model_raw || ''}`.trim();
      const base = { id: c.id, status: c.status, slice: c.slice, forum_id: c.forum_id || null, vehicle };
      const thread = state.getThread(c.thread_id);
      if (!thread?.thread_text) { results.push({ ...base, errored: true, reason: 'no thread text' }); continue; }
      try {
        const verdict = await judgeCase(thread.thread_text, c.payload, c.status);
        results.push({ ...base, ...verdict });
        newAudited.push(c.id); // attempted (judged or coverage-gap) → widen coverage over time
      } catch (err) {
        if (isStoppingError(err)) throw err; // quota/auth → stop; day NOT claimed → retry tomorrow
        results.push({ ...base, errored: true, reason: err.message });
      }
    }

    const judgedRows = results.filter(r => !r.parseFail && !r.errored);
    const unparsed = results.filter(r => r.parseFail).length;

    // Append today's judged labels first (so the pooled window includes today), then read pooled.
    if (!dryRun && judgedRows.length > 0) {
      if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
      const lines = judgedRows.map(r => JSON.stringify({
        ts: now.toISOString(), date: today, case_id: r.id, status: r.status, forum_id: r.forum_id,
        slice: r.slice, wrongly_accepted: !!r.wronglyAccepted, confidence: r.confidence, failed_condition: r.failedCondition, reason: r.reason,
      }));
      appendFileSync(LABELS_FILE, lines.join('\n') + '\n', 'utf8');
    }
    const labelLines = readLabelLines(LABELS_FILE);
    const pooled = pooledStatsFrom(labelLines, today, POOL_WINDOW_DAYS);
    const baseline = pooledStatsFrom(labelLines, today, POOL_BASELINE_DAYS);
    const decision = shouldAlertPrecision(results, pooled, { baseline });

    console.log(`precision-auditor: judged ${decision.judged}, wrongly-accepted ${decision.wrong} (${(decision.ratio * 100).toFixed(0)}%), pooled ${decision.pooledWrong}/${decision.pooledJudged} (${(decision.pooledRatio * 100).toFixed(0)}%), baseline ${(decision.baselineRatio * 100).toFixed(0)}% over ${POOL_BASELINE_DAYS}d, unparsed ${unparsed} → alert=${decision.alert}${decision.alert ? ` [${decision.severeHit ? 'severe' : ''}${decision.regressionHit ? 'regression' : ''}${decision.clusterHit ? 'cluster' : ''}]` : ''}`);

    if (dryRun) {
      console.log('precision-auditor: dry-run — nothing written (no report/metrics/labels/day-stamp).');
      return;
    }

    writeReport({ today, windowDays, poolSize: pool.length, results, decision, unparsed, sliceCounts });

    // Desktop marker (mirrored by run-coach-batch.ps1).
    if (decision.alert) {
      const why = decision.regressionHit && !decision.severeHit
        ? ` [zhoršení proti ${POOL_BASELINE_DAYS}d průměru ${(decision.baselineRatio * 100).toFixed(0)} %]`
        : decision.severeHit ? ' [vysoká míra]' : '';
      const msg = `Precizní auditor: z ${decision.judged} překontrolovaných schválených případů jich nezávislá kontrola označila ${decision.wrong} jako pravděpodobně chybně schválené`
        + (decision.pooledJudged ? ` (za ${POOL_WINDOW_DAYS} dní ${decision.pooledWrong}/${decision.pooledJudged})` : '')
        + why
        + (decision.clusterCount >= CLUSTER_MIN ? `; většina padá na podmínku ${decision.clusterClause}` : '')
        + `. Report: logs/precision-audit-${today}.md`;
      writeFileSync(ALERT_FILE, msg, 'utf8');
      state.log('warn', `precision-auditor: ${decision.wrong}/${decision.judged} approved look wrongly accepted (alert)`, 'coach');
    } else if (existsSync(ALERT_FILE)) {
      unlinkSync(ALERT_FILE); // recovered — clear stale alert
    }

    // Phase-4 structured signal: trend metrics + accumulating labelled judgements.
    state.recordMetric(today, 'precision_audited', decision.judged);
    state.recordMetric(today, 'precision_wrongly_accepted', decision.wrong);
    state.recordMetric(today, 'precision_high_conf', decision.highConf);
    state.recordMetric(today, 'precision_unparsed', unparsed);
    state.recordMetric(today, 'precision_false_accept_rate', decision.judged ? +(decision.wrong / decision.judged).toFixed(3) : 0);

    if (newAudited.length > 0) saveAuditedIds(state, [...auditedIds.filter(id => !newAudited.includes(id)), ...newAudited]);

    // Claim the day only after a real audit ran (something judged, or genuinely nothing to audit).
    if (judgedRows.length > 0 || pool.length === 0) state.setMeta(META_KEY, today);
    state.log('info', `precision-auditor ${today}: judged ${decision.judged}, wrong ${decision.wrong}, unparsed ${unparsed}, alert ${decision.alert}`, 'coach');
  } finally {
    state.close();
  }
}

const invokedDirectly = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedDirectly) await main();
