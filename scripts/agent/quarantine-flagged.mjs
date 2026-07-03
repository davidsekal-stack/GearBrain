/**
 * quarantine-flagged.mjs — ONE-OFF, owner-authorized (2026-07-03) reversible
 * quarantine of the precision auditor's wrongly-accepted cases.
 *
 * Auto-quarantine (alert-agent) is deliberately OFF; this is a MANUAL run the
 * owner explicitly approved ("zatáhnout všech 15 ne-lidských"). It reuses the
 * exact safe primitives from alert-agent: live-first CAS write, then the local
 * journal (knob 'quarantine'), with compensation if the journal write fails —
 * so every action is reversible via `apply-proposal.mjs --revert --knob quarantine`.
 *
 * Selection (precise): flagged wrongly_accepted in the last N days AND the LIVE
 * row is status='approved' AND reviewed_at IS NULL. That targets the 12
 * triage-auto + 3 bulk-review approvals and structurally EXCLUDES:
 *   - the cases the owner approved personally (reviewed_at is set),
 *   - cases still 'pending' (awaiting the human queue — do not preempt),
 *   - already-'rejected' cases.
 *
 * Usage (dry-run unless --apply):
 *   node --env-file=scripts/agent/.env.local --experimental-sqlite scripts/agent/quarantine-flagged.mjs
 *   node --env-file=scripts/agent/.env.local --experimental-sqlite scripts/agent/quarantine-flagged.mjs --apply
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AgentState } from './state.mjs';
import { setLiveCaseStatusByLocalId, resolveSupabaseReadKey } from './supabase-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT = __dirname;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nmvjthfezyjcwuzphiuu.supabase.co';
const KEY = resolveSupabaseReadKey(process.env);
const APPLY = process.argv.includes('--apply');
const DAYS = (() => { const i = process.argv.indexOf('--days'); return i === -1 ? 7 : Number(process.argv[i + 1]) || 7; })();

const APPROVED_LOCAL = new Set(['verified', 'import_ready', 'imported']);
const REASON_BY_CLAUSE = { a: 'not_car', b: 'not_a_fault', c: 'not_a_fault', d: 'unconfirmed', e: 'vehicle_mismatch' };
const caseVehicle = (c) => {
  try { const p = JSON.parse(c.payload_json || '{}'); return `${p.vehicle_brand || p.brand_raw || '?'} ${p.vehicle_model || p.model_raw || ''}`.trim(); }
  catch { return '?'; }
};

async function restGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  return r.ok ? r.json() : [];
}

async function run() {
  if (!KEY) { console.error('No Supabase read key.'); process.exit(1); }
  const labelsPath = join(AGENT, 'logs/precision-labels.jsonl');
  if (!existsSync(labelsPath)) { console.error('No precision-labels.jsonl.'); process.exit(1); }

  // Flagged wrongly-accepted ids (newest verdict wins; a later "fine" clears it).
  const cutoff = Date.now() - DAYS * 86_400_000;
  const flagged = new Map();
  for (const line of readFileSync(labelsPath, 'utf8').trim().split('\n')) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(r.ts || r.date || '');
    if (Number.isFinite(ts) && ts < cutoff) continue;
    if (r.wrongly_accepted !== true) { flagged.delete(r.case_id); continue; }
    flagged.set(r.case_id, r.failed_condition || 'd');
  }

  const ids = [...flagged.keys()];
  const inList = ids.map(encodeURIComponent).join(',');
  const live = await restGet(`gearbrain_cases?local_id=in.(${inList})&select=local_id,status,reviewed_at,vehicle_brand,vehicle_model`);
  const liveById = new Map(live.map(r => [r.local_id, r]));

  // Precise target set.
  const targets = ids.filter(id => {
    const l = liveById.get(id);
    return l && l.status === 'approved' && (l.reviewed_at == null || l.reviewed_at === '');
  });

  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} — flagged ${ids.length}; to quarantine (approved & reviewed_at NULL): ${targets.length}`);
  const excluded = ids.filter(id => !targets.includes(id)).map(id => {
    const l = liveById.get(id);
    const why = !l ? 'not-in-live' : l.status !== 'approved' ? `status=${l.status}` : 'human-approved (reviewed_at set)';
    return `  – skip ${id.slice(0, 8)} (${why})`;
  });
  for (const e of excluded) console.log(e);

  const state = new AgentState();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const done = [], skipped = [];

  for (const id of targets) {
    const l = liveById.get(id);
    const clause = flagged.get(id);
    const c = state.getCase(id);
    if (!c) { skipped.push(`${id.slice(0, 8)} lokálně nenalezen`); continue; }
    if (c.status === 'quarantined') { skipped.push(`${id.slice(0, 8)} už v karanténě`); continue; }
    if (!APPROVED_LOCAL.has(c.status)) { skipped.push(`${id.slice(0, 8)} lokální stav ${c.status}`); continue; }

    console.log(`  ⊘ ${l.vehicle_brand} ${l.vehicle_model || ''} — klauzule ${clause}  [${id.slice(0, 8)}]`);
    if (!APPLY) continue;

    const reviewReason = REASON_BY_CLAUSE[clause] || 'other';
    const liveRes = await setLiveCaseStatusByLocalId({
      supabaseUrl: SUPABASE_URL, serviceKey: KEY, localId: id,
      patch: { status: 'rejected', review_reason: reviewReason, reviewed_at: now.toISOString() },
      expectStatuses: ['approved'],   // CAS: only an approved (never human-reviewed here) row
    });
    if (!liveRes.ok) { skipped.push(`${id.slice(0, 8)} živý zápis: ${liveRes.reason}`); continue; }
    // CAS skipped (row is no longer 'approved' — changed under us) → do NOT mark
    // it quarantined locally; leave it untouched.
    if (!liveRes.updated) { skipped.push(`${id.slice(0, 8)} živý CAS přeskočen (stav ${liveRes.previousStatus ?? '?'})`); continue; }

    const res = state.applyCaseChange({
      date: today, caseId: id, label: caseVehicle(c), knob: 'quarantine', reasonCode: `precision_${clause}`,
      signal: { live_pulled: !!liveRes.updated, live_found: !!liveRes.found, live_prev_status: liveRes.previousStatus ?? null, failed_condition: clause, confidence: 'high', manual: true },
      oldFields: { status: c.status }, newFields: { status: 'quarantined' },
    });
    if (res.ok) { done.push(id); }
    else {
      skipped.push(`${id.slice(0, 8)} deník: ${res.reason}`);
      // Journal failed after the live pull → compensate so nothing is left un-revertable.
      if (liveRes.updated) {
        const back = await setLiveCaseStatusByLocalId({
          supabaseUrl: SUPABASE_URL, serviceKey: KEY, localId: id,
          patch: { status: liveRes.previousStatus, review_reason: null, reviewed_at: null }, expectStatuses: ['rejected'],
        });
        state.log(back.ok && back.updated ? 'info' : 'warn', `quarantine-flagged: ${id} compensation ${back.ok && back.updated ? 'ok' : 'FAILED (manual restore needed)'}`, 'coach');
      }
    }
  }

  console.log(`\n${APPLY ? 'Done' : 'Dry-run'}: ${APPLY ? `quarantined ${done.length}` : `would quarantine ${targets.length}`}, skipped ${skipped.length}.`);
  for (const s of skipped) console.log(`  · ${s}`);
  if (APPLY) console.log(`Undo: node --experimental-sqlite scripts/agent/apply-proposal.mjs --revert --knob quarantine`);
  state.close();
}

run();
