/**
 * retry-failed-calibrations.mjs — periodically un-rot calibration_failed forums
 * (review 2026-07-02, point 10). 22 % of the pool was stuck failed forever:
 * getForumsPendingCalibration excludes calibration_failed, and the only escape
 * was a manual `reset-forum.mjs --all-failed`.
 *
 * Two cohorts:
 *  1) FAILED but a hand-written profile now matches — apply the profile directly
 *     (no LLM). These are forums that failed autocalibration BEFORE their profile
 *     was written (the 54-profile batches); they never picked it up because a
 *     failed forum "profil sám nezvedne". Pure win, no cost.
 *  2) FAILED with no profile — re-arm to 'discovered' so the nightly calibrate
 *     retries with current code, BOUNDED (RETRY_MAX_PER_RUN) and with per-forum
 *     exponential backoff (RETRY_AFTER_DAYS × 2^priorRetries), so genuinely dead
 *     domains (NXDOMAIN, login-walled) fade out instead of burning budget monthly.
 *
 * Self-gates to once per RETRY_INTERVAL_DAYS (agent_meta). Reversible: it only
 * moves failed→discovered/queued; a re-fail returns it to failed naturally.
 *
 * Usage (auto-applies like recalibrate-guarded; --dry-run to preview):
 *   node --experimental-sqlite retry-failed-calibrations.mjs [--dry-run] [--force]
 */

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { AgentState } from './state.mjs';
import { loadProfiles, getForumProfile, applyProfileToForum } from './forum-profiles.mjs';
import { resetForum } from './reset-forum.mjs';

const RETRY_INTERVAL_DAYS = intEnv('RETRY_INTERVAL_DAYS', 30);   // whole-step cadence
const RETRY_AFTER_DAYS    = intEnv('RETRY_AFTER_DAYS', 30);      // base per-forum backoff
const RETRY_MAX_PER_RUN   = intEnv('RETRY_MAX_PER_RUN', 3);      // profile-less re-arms / run
const RETRY_BACKOFF_CAP_DAYS = intEnv('RETRY_BACKOFF_CAP_DAYS', 180);
const META_LAST   = 'calib_retry_last_date';
const META_STATE  = 'calib_retry_state';  // JSON { [forumId]: { n, last } }

function intEnv(name, dflt) { const v = parseInt(process.env[name] ?? '', 10); return Number.isFinite(v) ? v : dflt; }

function daysBetween(aIso, bIso) {
  const a = Date.parse(aIso), b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(b - a) / 86_400_000;
}

/**
 * Pure planner (testable, no DB/IO). Given the failed forums, the loaded
 * profiles, the per-forum retry state and today's date, decide which to
 * profile, which to re-arm, and which to skip (backoff not elapsed).
 */
export function planCalibrationRetry({ forums, profiles, retryState = {}, today, opts = {} }) {
  const maxPerRun = opts.maxPerRun ?? RETRY_MAX_PER_RUN;
  const afterDays = opts.afterDays ?? RETRY_AFTER_DAYS;
  const capDays = opts.capDays ?? RETRY_BACKOFF_CAP_DAYS;

  const failed = forums.filter(f => f.status === 'calibration_failed' || f.calibration_status === 'failed');

  const applyProfile = [];
  const rearmCandidates = [];
  for (const f of failed) {
    const profile = getForumProfile(f.url, profiles);
    if (profile) { applyProfile.push({ forum: f, profile }); continue; }
    rearmCandidates.push(f);
  }

  // Profile-less: gate each by exponential backoff, then take the oldest-created
  // eligible ones up to the cap (oldest created ⇒ longest-neglected first).
  const eligible = [];
  const skipped = [];
  for (const f of rearmCandidates) {
    const st = retryState[f.id] || { n: 0, last: null };
    const wait = Math.min(afterDays * Math.pow(2, st.n), capDays);
    const since = st.last ? daysBetween(st.last, today) : Infinity;
    if (since >= wait) eligible.push({ forum: f, priorRetries: st.n });
    else skipped.push({ forum: f, waitDays: Math.ceil(wait - since) });
  }
  eligible.sort((a, b) => String(a.forum.created_at || '').localeCompare(String(b.forum.created_at || '')));
  const rearm = eligible.slice(0, maxPerRun);
  const deferred = eligible.slice(maxPerRun); // eligible but over the per-run cap

  return { applyProfile, rearm, skipped, deferred };
}

function gateByDate(state, today, force) {
  if (force) return true;
  const last = state.getMeta(META_LAST);
  if (!last) return true;
  return daysBetween(last, today) >= RETRY_INTERVAL_DAYS;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const today = new Date().toISOString().slice(0, 10);
  const state = new AgentState();

  if (!gateByDate(state, today, force)) {
    console.log(`retry-failed-calibrations: skip — ran within ${RETRY_INTERVAL_DAYS} days (use --force).`);
    state.close();
    return;
  }

  const forums = state.getAllForums();
  const profiles = loadProfiles();
  let retryState = {};
  try { retryState = JSON.parse(state.getMeta(META_STATE) || '{}') || {}; } catch { retryState = {}; }

  const plan = planCalibrationRetry({ forums, profiles, retryState, today });

  console.log(`${dryRun ? 'DRY-RUN' : 'APPLY'} — calibration_failed: profile-match ${plan.applyProfile.length}, re-arm ${plan.rearm.length} (of ${plan.rearm.length + plan.deferred.length} eligible), skipped-backoff ${plan.skipped.length}.`);
  for (const { forum, profile } of plan.applyProfile) console.log(`  ↑ profile  ${forum.name || forum.url}  (${profile.match})`);
  for (const { forum, priorRetries } of plan.rearm) console.log(`  ↻ re-arm   ${forum.name || forum.url}  (prior retries: ${priorRetries})`);
  for (const { forum, waitDays } of plan.skipped) console.log(`  · backoff  ${forum.name || forum.url}  (~${waitDays}d)`);

  if (dryRun) { console.log('\nDry-run — nothing written.'); state.close(); return; }

  for (const { forum, profile } of plan.applyProfile) applyProfileToForum(state, forum.id, profile);
  for (const { forum } of plan.rearm) {
    resetForum(state, forum);
    const st = retryState[forum.id] || { n: 0, last: null };
    retryState[forum.id] = { n: st.n + 1, last: today };
  }

  state.setMeta(META_STATE, JSON.stringify(retryState));
  state.setMeta(META_LAST, today);
  console.log(`\nDone: applied ${plan.applyProfile.length} profile(s), re-armed ${plan.rearm.length} forum(s). Next run allowed after ${RETRY_INTERVAL_DAYS} days.`);
  state.close();
}

const invokedDirectly = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedDirectly) main();
