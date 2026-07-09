/**
 * recall-watchdog.mjs — daily recall audit of the independent verifier.
 *
 * The cross-vendor verifier (verify.mjs, DeepSeek) is the last automatic gate
 * before the human review queue. It was hardened (2026-06-17) to reject several
 * non-fault / out-of-scope / mismatched classes. The risk of any strict gate is
 * the opposite failure: silently rejecting GOOD cases (recall regression) on
 * patterns we didn't anticipate. The verifier cannot detect that about itself.
 *
 * This watchdog runs once per day (after the night crawl window) and:
 *   1. Canary (free): reject-rate + per-failing-condition breakdown over the
 *      recent window — logged so a sudden spike is visible.
 *   2. Cross-vendor re-check: a SAMPLE of recent `verify_rejected` cases is
 *      re-judged by an INDEPENDENT model (Claude — a different vendor than the
 *      DeepSeek verifier) against the same quality bar. If Claude thinks the
 *      verifier wrongly rejected a genuine in-scope diagnosed+repaired fault, it
 *      is flagged. When the wrongly-rejected rate clears a threshold, an alert
 *      file is written (the batch wrapper mirrors it to a Desktop marker).
 *
 * A markdown report is always written to logs/recall-audit-YYYY-MM-DD.md. The
 * accumulating agree/disagree judgements double as labelled data for future
 * verifier-prompt tuning.
 *
 * Self-gating: runs at most once per local day, only at/after RECALL_AUDIT_HOUR
 * (default 07:00) so it evaluates the completed night. The batch wrapper can
 * therefore call it every cycle cheaply (it no-ops until due). --force overrides.
 *
 * Routing: registers its own task route via the env-override mechanism in
 * llm.mjs (AGENT_LLM_RECALL-AUDIT), so it needs no change to the shared router.
 *
 * Usage:
 *   node --experimental-sqlite recall-watchdog.mjs [--force] [--sample N] [--days N] [--dry-run]
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AgentState } from './state.mjs';
import { isStoppingError } from './quota.mjs';
import { QUALITY_BAR } from './quality-bar.mjs';
import { promptField, promptList } from './prompt-sanitize.mjs';
import { caseAnchorBlock, windowThread, JUDGE_FULL_CAP } from './judge-context.mjs';

// Re-export so existing importers (tests, precision-auditor) keep one source of truth.
export { QUALITY_BAR };

const __dirname = dirname(fileURLToPath(import.meta.url));

// Route the recall-audit task to Claude (independent of the DeepSeek verifier).
// Set BEFORE importing/using runLlm's route resolution; env override wins over
// DEFAULT_ROUTES, so we avoid editing the shared llm.mjs.
if (!process.env['AGENT_LLM_RECALL-AUDIT']) {
  process.env['AGENT_LLM_RECALL-AUDIT'] = 'claude:haiku';
}
const { runLlm } = await import('./llm.mjs');

// ── Tunables (env-overridable) ──────────────────────────────────────────────
const SAMPLE_SIZE   = intEnv('RECALL_AUDIT_SAMPLE', 12);   // rejects re-checked per day
const WINDOW_DAYS   = intEnv('RECALL_AUDIT_DAYS', 2);      // how far back to look
// Closed morning gate [EVAL_HOUR, EVAL_HOUR_END): runs from the dedicated post-night
// task (run-coach-batch.ps1, ~06:20). A lower-bound-only gate let evening batches fire it.
const EVAL_HOUR     = intEnv('RECALL_AUDIT_HOUR', 6);
const EVAL_HOUR_END = intEnv('RECALL_AUDIT_HOUR_END', 21);
const ALERT_RATE    = floatEnv('RECALL_AUDIT_ALERT_RATE', 0.30); // flag if ≥30% wrongly rejected
const ALERT_MIN     = intEnv('RECALL_AUDIT_ALERT_MIN', 3);  // …and at least this many (small-sample guard)
const AUDIT_TIMEOUT_MS = 90_000;
const AUDIT_MAX_TOKENS = 300;
const MAX_THREAD_CHARS = JUDGE_FULL_CAP; // backstop; windowThread (call site) does the real capping

const META_KEY = 'recall_audit_last_date';
const ALERT_FILE = join(__dirname, 'recall-alert.txt');

function intEnv(name, dflt)   { const v = parseInt(process.env[name] ?? '', 10); return Number.isFinite(v) ? v : dflt; }
function floatEnv(name, dflt) { const v = parseFloat(process.env[name] ?? '');   return Number.isFinite(v) ? v : dflt; }

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** Pull the failing verifier condition out of a stored review_note. */
export function failingCondition(reviewNote) {
  const note = (reviewNote || '').toString();
  const m = note.match(/failed:([a-z_]+)/i);
  if (m) return m[1];
  if (/pre-gate/i.test(note)) return 'pre-gate';
  if (/not valid JSON/i.test(note)) return 'parse-fail';
  return 'other';
}

/** Count rejects by failing condition. */
export function summarizeConditions(rejects) {
  const by = {};
  for (const r of rejects) {
    const c = failingCondition(r.review_note);
    by[c] = (by[c] || 0) + 1;
  }
  return by;
}

/** Parse the independent auditor's JSON verdict. Fail-closed to "agree" (not a
 *  recall problem) on garbage, so a flaky parse never raises a false alarm. */
export function parseAuditVerdict(raw) {
  const text = (raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { wronglyRejected: false, reason: 'unparseable', parseFail: true };
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return {
      wronglyRejected: obj.wrongly_rejected === true,
      reason: (typeof obj.reason === 'string' ? obj.reason : '').slice(0, 200),
      confidence: typeof obj.confidence === 'string' ? obj.confidence : 'unknown',
    };
  } catch {
    return { wronglyRejected: false, reason: 'unparseable', parseFail: true };
  }
}

/** Alert only on a PATTERN (rate AND minimum count), to avoid single-case noise. */
export function shouldAlert(results, { rate = ALERT_RATE, min = ALERT_MIN } = {}) {
  const judged = results.filter(r => !r.parseFail && !r.errored);
  const wrong = judged.filter(r => r.wronglyRejected);
  const ratio = judged.length ? wrong.length / judged.length : 0;
  return { alert: wrong.length >= min && ratio >= rate, wrong: wrong.length, judged: judged.length, ratio };
}

/** Build the independent re-check prompt. */
export function buildAuditPrompt(threadText, caseObj, verifierReason, anchorBlock = '') {
  const text = (threadText || '').length > MAX_THREAD_CHARS
    ? threadText.slice(0, MAX_THREAD_CHARS) + '\n[...truncated...]'
    : (threadText || '');
  const brand = promptField(caseObj.vehicle_brand || caseObj.brand_raw || '?', 80);
  const model = promptField(caseObj.vehicle_model || caseObj.model_raw || '?', 80);
  const engine = promptField(caseObj.engine_power || caseObj.engine_raw || '', 80);
  return `An automated verifier REJECTED the extracted case below (so it will NOT enter the database). Independently decide whether that rejection was a mistake — i.e. the case actually meets the quality bar and a useful repair case was lost.

${QUALITY_BAR} IMPORTANT: only mark wrongly_rejected=true if the case clearly meets ALL of (a)-(e); if it fails (d) or (e), the rejection was CORRECT.
${anchorBlock ? `\n${anchorBlock}\n` : ''}
VERIFIER'S STATED REJECT REASON: ${verifierReason || '(none)'}

EXTRACTED CASE:
  Vehicle: ${brand} ${model} ${engine}
  Symptoms: ${promptList(caseObj.symptoms)}
  Description: ${promptField(caseObj.description)}
  Resolution: ${promptField(caseObj.resolution)}

ORIGINAL THREAD:
---
${text}
---

Set wrongly_rejected=true ONLY if you are confident the case clearly meets the bar and should have been kept. If the rejection looks correct or it is genuinely borderline, set false. Respond with ONE JSON object, nothing else:
{"wrongly_rejected":false,"confidence":"low|medium|high","reason":"<=20 words"}`;
}

/** Local YYYY-MM-DD. */
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** UTC 'YYYY-MM-DD HH:MM:SS' cutoff `days` ago (matches SQLite created_at format). */
function utcCutoff(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
}

// ── Main ────────────────────────────────────────────────────────────────────

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
    // ── Self-gate: once per day, after the night window ──
    if (!force) {
      const h = now.getHours();
      if (h < EVAL_HOUR || h >= EVAL_HOUR_END) {
        console.log(`recall-watchdog: mimo ranní okno (${EVAL_HOUR}:00–${EVAL_HOUR_END}:00) — skipping.`);
        return;
      }
      if (state.getMeta(META_KEY) === today) {
        console.log('recall-watchdog: already ran today — skipping.');
        return;
      }
    }

    const cutoff = utcCutoff(windowDays);
    const allRejects = state.getCasesByStatus('verify_rejected', 2000)
      .filter(r => (r.created_at || '') >= cutoff)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    // Canary: windowed reject-rate (current status of cases created in window).
    const passLike = ['verified', 'imported', 'import_ready', 'crosscheck_dupe'];
    let passCount = 0;
    for (const s of passLike) {
      passCount += state.getCasesByStatus(s, 5000).filter(r => (r.created_at || '') >= cutoff).length;
    }
    const denom = passCount + allRejects.length;
    const rejectRate = denom ? allRejects.length / denom : 0;
    const byCondition = summarizeConditions(allRejects);

    console.log(`recall-watchdog: window=${windowDays}d rejects=${allRejects.length} reject-rate=${(rejectRate * 100).toFixed(0)}% conditions=${JSON.stringify(byCondition)}`);

    // Sample most-recent rejects for the cross-vendor re-check.
    const sample = allRejects.slice(0, Math.max(0, sampleSize));
    const results = [];
    for (const c of sample) {
      let payload = {};
      try { payload = JSON.parse(c.payload_json); } catch { /* keep {} */ }
      const thread = state.getThread(c.thread_id);
      const verifierReason = (c.review_note || '').replace(/^Verifier:\s*/i, '');
      const base = {
        id: c.id,
        vehicle: `${payload.brand_raw || payload.vehicle_brand || '?'} ${payload.model_raw || payload.vehicle_model || ''}`.trim(),
        condition: failingCondition(c.review_note),
        verifierReason,
      };
      if (!thread?.thread_text) { results.push({ ...base, errored: true, reason: 'no thread text' }); continue; }
      const { text: windowed } = windowThread(thread.thread_text, {
        caseAuthor: payload.case_author, faultPostNumbers: payload.fault_post_numbers,
        resolutionPostNumbers: payload.resolution_post_numbers, confirmationPostNumber: payload.confirmation_post_number,
      });
      try {
        const raw = await runLlm('recall-audit', buildAuditPrompt(windowed, payload, verifierReason, caseAnchorBlock(payload)), {
          timeoutMs: AUDIT_TIMEOUT_MS, maxTokens: AUDIT_MAX_TOKENS, temperature: 0,
        });
        results.push({ ...base, ...parseAuditVerdict(raw) });
      } catch (err) {
        if (isStoppingError(err)) throw err; // quota/auth → stop; day already claimed, retry tomorrow
        results.push({ ...base, errored: true, reason: err.message });
      }
    }

    const decision = shouldAlert(results);
    console.log(`recall-watchdog: re-checked ${decision.judged}, wrongly-rejected ${decision.wrong} (${(decision.ratio * 100).toFixed(0)}%) → alert=${decision.alert}`);

    if (!dryRun) {
      writeReport({ today, windowDays, rejectRate, byCondition, totalRejects: allRejects.length, results, decision });
      // Alert file is mirrored to the Desktop by the batch wrapper.
      if (decision.alert) {
        const msg = `Verifikátor možná zamítá moc přísně: z ${decision.judged} přehodnocených zamítnutí jich nezávislá kontrola označila ${decision.wrong} (${(decision.ratio * 100).toFixed(0)}%) jako pravděpodobně dobré. Report: logs/recall-audit-${today}.md`;
        writeFileSync(ALERT_FILE, msg, 'utf8');
        state.log('warn', `recall-watchdog: ${decision.wrong}/${decision.judged} rejects look wrongly rejected (≥ threshold)`, 'recall-audit');
      } else if (existsSync(ALERT_FILE)) {
        unlinkSync(ALERT_FILE); // recovered — clear stale alert
      }
      // Stamp once-per-day only AFTER a successful audit+report (a mid-run crash/quota
      // leaves the slot open to retry; the dedicated task fires once/day anyway).
      state.setMeta(META_KEY, today);
    }
  } finally {
    state.close();
  }
}

function writeReport({ today, windowDays, rejectRate, byCondition, totalRejects, results, decision }) {
  const logDir = join(__dirname, 'logs');
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const lines = [];
  lines.push(`# Recall audit — ${today}`, '');
  lines.push(`- Window: last ${windowDays} day(s)`);
  lines.push(`- Rejects in window: ${totalRejects}  ·  reject-rate: ${(rejectRate * 100).toFixed(0)}%`);
  lines.push(`- Failing conditions: ${JSON.stringify(byCondition)}`);
  lines.push(`- Re-checked (cross-vendor): ${decision.judged}  ·  flagged wrongly-rejected: ${decision.wrong} (${(decision.ratio * 100).toFixed(0)}%)`);
  lines.push(`- Alert: ${decision.alert ? '⚠️ YES — verifier may be over-rejecting' : 'no'}`, '');
  lines.push('| case | vehicle | verifier said | independent re-check |', '|---|---|---|---|');
  for (const r of results) {
    const verdict = r.errored ? `(skipped: ${r.reason})` : (r.wronglyRejected ? `⚠️ WRONGLY REJECTED — ${r.reason}` : `ok — ${r.reason || 'reject upheld'}`);
    lines.push(`| ${r.id.slice(0, 8)} | ${r.vehicle} | ${(r.verifierReason || '').slice(0, 60)} | ${verdict} |`);
  }
  lines.push('');
  writeFileSync(join(logDir, `recall-audit-${today}.md`), lines.join('\n'), 'utf8');
}

function intArg(args, flag, dflt) {
  const i = args.indexOf(flag);
  if (i === -1) return dflt;
  const v = parseInt(args[i + 1], 10);
  return Number.isFinite(v) ? v : dflt;
}

// Run only when invoked directly (not when imported by tests).
const invokedDirectly = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedDirectly) await main();
