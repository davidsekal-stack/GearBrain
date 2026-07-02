/**
 * audit-clause-d.mjs — one-off audit of the review-queue cases held back on clause (d)
 * "repair not confirmed to have worked".
 *
 * Owner's call (2026-06-29): do NOT loosen the bar (an unconfirmed repair stays out of the
 * DB), but check whether the confirmation is GENUINELY absent from the thread, or whether
 * our triage MIS-evaluated it (the thread does confirm the fix, the nightly judge just
 * missed it). This re-reads each clause-(d) case against its original thread with an
 * INDEPENDENT model (DeepSeek — different vendor than the Claude triage that flagged it) and
 * a STRICTER test than the relaxed auto-approve bar: a case is cleared ONLY if a VERBATIM
 * quote in the thread positively confirms THIS repair fixed the fault. No quote → stays
 * disputable. So we keep the strict standard AND catch the triage's false positives.
 *
 * Cleared cases (triage errors) → approved + queue row resolved, with the confirming quote
 * recorded in human_note. REVERSIBLE: a backup JSON records the prior live status.
 *
 * Usage (dry-run unless --apply):
 *   node --env-file=scripts/agent/.env.local --experimental-sqlite \
 *     scripts/agent/audit-clause-d.mjs [--apply] [--max N]
 *   node ... scripts/agent/audit-clause-d.mjs --revert <backup.json>
 */

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { deepseekChat } from './llm.mjs';
import { promptField, promptList } from './prompt-sanitize.mjs';
import {
  fetchOpenReviewQueueRows, setLiveCaseStatusByLocalId, deleteReviewQueueRow,
} from './supabase-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'agent.db');
const BACKUP_DIR = join(__dirname, `.clause-d-audit-${new Date().toISOString().slice(0, 10)}`);
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nmvjthfezyjcwuzphiuu.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

const MAX_THREAD_CHARS = 60_000;
const MIN_QUOTE_CHARS = 8;

const APPLY = process.argv.includes('--apply');
const REVERT_FILE = (() => { const i = process.argv.indexOf('--revert'); return i === -1 ? null : process.argv[i + 1]; })();
const MAX = (() => { const i = process.argv.indexOf('--max'); return i === -1 ? Infinity : Number(process.argv[i + 1]); })();

function norm(s) { return (s ?? '').toString().toLowerCase().replace(/\s+/g, ' ').trim(); }
function snippet(s, n = 90) { return norm(s).slice(0, n); }

function buildPrompt(threadText, c) {
  const text = (threadText || '').length > MAX_THREAD_CHARS ? threadText.slice(0, MAX_THREAD_CHARS) + '\n[...]' : (threadText || '');
  return `A repair case was extracted from the forum thread below and is awaiting approval. It was held back because an automated judge could not confirm the repair actually FIXED the fault. Re-check ONLY that question against the thread.

The case is CONFIRMED only if the thread contains a clear statement — by the car's OWNER (the SAME user who reported the fault) — that AFTER this repair the original fault was GONE / the car worked / the problem was solved. A plan to try it, "I'll report back", ordering a part, or an ambiguous outcome is NOT a confirmation.

CASE:
  Vehicle: ${promptField(c.vehicle_brand || '?', 80)} ${promptField(c.vehicle_model || '', 80)}
  Symptoms: ${promptList(c.symptoms)}
  Repair: ${promptField(c.resolution)}

THREAD:
---
${text}
---

If and ONLY if the thread positively confirms the fix worked, set confirmed=true and put in "quote" a SHORT VERBATIM excerpt copied EXACTLY from the thread above that states the success (do not paraphrase or invent). Otherwise confirmed=false and quote "". Respond with ONE JSON object only:
{"confirmed":true|false,"quote":"<verbatim success quote or empty>","reason":"<short>"}`;
}

function parseVerdict(raw) {
  const t = (raw || '').trim(); const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e <= s) return { confirmed: false, quote: '', reason: 'unparseable' };
  try { const o = JSON.parse(t.slice(s, e + 1)); return { confirmed: o.confirmed === true, quote: typeof o.quote === 'string' ? o.quote : '', reason: (o.reason || '').toString().slice(0, 200) }; }
  catch { return { confirmed: false, quote: '', reason: 'unparseable' }; }
}

async function liveCaseByLocalId(localId) {
  const u = `${SUPABASE_URL}/rest/v1/gearbrain_cases?local_id=eq.${encodeURIComponent(localId)}&select=id,status,vehicle_brand,vehicle_model,symptoms,description,resolution&limit=1`;
  const r = await fetch(u, { headers: H }); if (!r.ok) return null;
  const rows = await r.json(); return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function revert(file) {
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`Reverting ${backup.length} case(s)...`);
  for (const b of backup) {
    const r = await setLiveCaseStatusByLocalId({ supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY, localId: b.local_id, patch: { status: b.prev_status, reviewed_at: null }, expectStatuses: ['approved'] });
    console.log(`  ${r.ok && r.updated ? '↩' : '–'} ${b.local_id.slice(0, 10)} → ${b.prev_status}`);
  }
}

async function run() {
  if (!SERVICE_KEY) { console.error('SUPABASE_SERVICE_KEY not set.'); process.exit(1); }
  if (!process.env.DEEPSEEK_API_KEY) { console.error('DEEPSEEK_API_KEY not set.'); process.exit(1); }

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const q = await fetchOpenReviewQueueRows({ supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY, select: 'case_local_id,clause' });
  if (!q.ok) { console.error('cannot read queue:', q.reason); process.exit(1); }
  let dRows = q.rows.filter(r => r.clause === 'd');
  if (Number.isFinite(MAX)) dRows = dRows.slice(0, MAX);
  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} — auditing ${dRows.length} clause-(d) cases.\n`);

  const backup = [];
  let confirmed = 0, unconfirmed = 0, noThread = 0, errors = 0;
  for (let i = 0; i < dRows.length; i++) {
    const localId = dRows[i].case_local_id;
    const live = await liveCaseByLocalId(localId);
    if (!live || live.status !== 'pending') { continue; } // already decided elsewhere
    const agentCase = db.prepare(`SELECT thread_id FROM cases WHERE id=?`).get(localId);
    const thread = agentCase?.thread_id ? db.prepare(`SELECT thread_text FROM threads WHERE id=?`).get(agentCase.thread_id) : null;
    const threadText = thread?.thread_text || '';
    if (threadText.trim().length < 200) { noThread++; continue; }

    let v;
    try {
      const raw = await deepseekChat({ apiKey: process.env.DEEPSEEK_API_KEY, prompt: buildPrompt(threadText, live), maxTokens: 400, temperature: 0 });
      v = parseVerdict(raw);
    } catch (e) { errors++; console.error(`  [${i + 1}/${dRows.length}] ${localId.slice(0, 10)} error: ${e.message}`); continue; }

    const quoteOk = v.confirmed && v.quote && v.quote.trim().length >= MIN_QUOTE_CHARS && norm(threadText).includes(norm(v.quote));
    if (quoteOk) {
      confirmed++;
      console.log(`  ✓ CANDIDATE ${localId}  ${live.vehicle_brand} ${live.vehicle_model}`);
      console.log(`      symptoms: ${promptList(live.symptoms)}`);
      console.log(`      fix: ${snippet(live.resolution, 140)}`);
      console.log(`      proof: «${norm(v.quote).slice(0, 280)}»`);
      if (APPLY) {
        const res = await setLiveCaseStatusByLocalId({ supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY, localId, patch: { status: 'approved' }, expectStatuses: ['pending'] });
        if (res.ok && res.updated) {
          backup.push({ local_id: localId, prev_status: 'pending' });
          // record the confirming quote on the queue row (best-effort) before resolving it
          await fetch(`${SUPABASE_URL}/rest/v1/crawl_review_queue?case_local_id=eq.${encodeURIComponent(localId)}`, {
            method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolved_at: new Date().toISOString(), decision: 'approved', human_note: `auto-audit clause-d: potvrzeno citací «${v.quote.slice(0, 300)}»` }),
          }).catch(() => {});
        }
      }
    } else if (v.confirmed && !quoteOk) {
      // model claimed confirmed but no verbatim proof → treat as unconfirmed (no fabrication)
      unconfirmed++;
    } else {
      unconfirmed++;
    }
  }
  db.close();

  console.log(`\n${'='.repeat(56)}`);
  console.log(`Audited:                 ${dRows.length}`);
  console.log(`Triage MISJUDGED (confirmed in thread): ${confirmed}  ${APPLY ? '→ approved' : '→ would approve'}`);
  console.log(`Genuinely unconfirmed (correctly held): ${unconfirmed}`);
  if (noThread) console.log(`No thread text (skipped): ${noThread}`);
  if (errors) console.log(`Errors: ${errors}`);

  if (APPLY && backup.length) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const f = join(BACKUP_DIR, 'clause-d-audit-backup.json');
    writeFileSync(f, JSON.stringify(backup, null, 2));
    console.log(`\nBackup: ${f}\nRevert: node --env-file=scripts/agent/.env.local --experimental-sqlite scripts/agent/audit-clause-d.mjs --revert "${f}"`);
  } else if (!APPLY) {
    console.log(`\nDry-run — nothing changed. Re-run with --apply to approve the misjudged cases.`);
  }
}

if (REVERT_FILE) await revert(REVERT_FILE);
else await run();
