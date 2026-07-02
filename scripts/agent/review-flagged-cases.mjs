/**
 * review-flagged-cases.mjs — READ-ONLY. Prepares the precision auditor's
 * wrongly-accepted flags for an owner decision (review 2026-07-02, point 3).
 *
 * The precision auditor writes labels to logs/precision-labels.jsonl but never
 * acts on them (report-only), and the alert text says "wrongly approved" while
 * some flagged cases are already rejected, still pending, or were approved by
 * the owner personally. This tool cuts through that: it cross-references the
 * flagged ids against the LIVE gearbrain_cases + crawl_review_queue and prints
 * the cases that are STILL live-approved, grouped by HOW they were approved, so
 * the owner can decide what to quarantine. It writes NOTHING (no quarantine, no
 * status change) — the quarantine decision stays the owner's.
 *
 * Usage:
 *   node --env-file=scripts/agent/.env.local --experimental-sqlite \
 *     scripts/agent/review-flagged-cases.mjs [--days N] [--out <file>]
 */

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT = __dirname;
const DB_PATH = join(AGENT, 'agent.db');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nmvjthfezyjcwuzphiuu.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_KEY || '';

const DAYS = (() => { const i = process.argv.indexOf('--days'); return i === -1 ? 7 : Number(process.argv[i + 1]) || 7; })();
const OUT = (() => { const i = process.argv.indexOf('--out'); return i === -1 ? null : process.argv[i + 1]; })();

function loadBackupIds(rel) {
  const p = join(AGENT, rel);
  if (!existsSync(p)) return new Set();
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const arr = Array.isArray(j) ? j : (j.cases || []);
    return new Set(arr.map(x => x.local_id || x.case_local_id || x.id).filter(Boolean));
  } catch { return new Set(); }
}

async function restGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  return r.ok ? r.json() : [];
}

async function run() {
  if (!KEY) { console.error('SUPABASE_SERVICE_KEY not set (needed to read live case status).'); process.exit(1); }

  // 1) flagged wrongly-accepted ids from the label log, last N days, newest verdict wins.
  const labelsPath = join(AGENT, 'logs/precision-labels.jsonl');
  if (!existsSync(labelsPath)) { console.error('No precision-labels.jsonl yet — the precision auditor has not run.'); process.exit(1); }
  const cutoff = Date.now() - DAYS * 24 * 3600 * 1000;
  const flagged = new Map(); // case_id -> { clause, day, confidence, reason }
  for (const line of readFileSync(labelsPath, 'utf8').trim().split('\n')) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(r.ts || r.date || '');
    if (Number.isFinite(ts) && ts < cutoff) continue;
    if (r.wrongly_accepted !== true) { flagged.delete(r.case_id); continue; } // a later "fine" verdict clears it
    flagged.set(r.case_id, { clause: r.failed_condition || '?', day: (r.date || '').slice(0, 10), confidence: r.confidence || '?', reason: r.reason || '' });
  }
  if (flagged.size === 0) { console.log(`No wrongly-accepted flags in the last ${DAYS} days.`); return; }

  // 2) live status + queue decision + case detail.
  const ids = [...flagged.keys()];
  const inList = ids.map(encodeURIComponent).join(',');
  const live = await restGet(`gearbrain_cases?local_id=in.(${inList})&select=local_id,status,reviewed_at,vehicle_brand,vehicle_model,symptoms,resolution,thread_url`);
  const liveById = new Map(live.map(r => [r.local_id, r]));

  // 3) approval-route backups.
  const bulk = new Set([...loadBackupIds('.bulk-review-2026-06-30/backup.json'), ...loadBackupIds('.bulk-review-2026-06-30/backup-phase2.json')]);
  const clauseD = loadBackupIds('.clause-d-audit-2026-06-29/backup.json');

  const routeOf = (l) => {
    if (!l) return 'not-in-live-db';
    if (l.status === 'rejected') return 'already-rejected';
    if (l.status === 'pending') return 'still-pending';
    if (clauseD.has(l.local_id)) return 'assisted:clause-d-audit';
    if (bulk.has(l.local_id)) return 'assisted:bulk-review';
    if (l.status === 'approved' && l.reviewed_at) return 'human:individual';
    if (l.status === 'approved') return 'triage:auto';
    return `other:${l.status}`;
  };

  const groups = {};
  for (const id of ids) {
    const l = liveById.get(id);
    const route = routeOf(l);
    (groups[route] ||= []).push({ id, l, f: flagged.get(id) });
  }

  const LIVE_ROUTES = ['triage:auto', 'assisted:bulk-review', 'assisted:clause-d-audit', 'human:individual'];
  const stillLive = LIVE_ROUTES.flatMap(r => groups[r] || []);

  const L = [];
  const p = (s = '') => { L.push(s); };
  p(`# Označené případy k rozhodnutí — posledních ${DAYS} dní`);
  p(`Zdroj: precizní auditor (logs/precision-labels.jsonl). Tento nástroj NIC nemění.`);
  p('');
  p(`Celkem označeno: **${ids.length}**. Rozpad podle stavu/cesty schválení:`);
  for (const [route, items] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
    p(`- ${route}: ${items.length}`);
  }
  p('');
  p(`## Stále živě schválené k rozhodnutí: ${stillLive.length}`);
  p(`(už zamítnuté / stále pending / mimo DB se neřeší — auditor je počítá, ale expozice nejsou)`);
  p('');
  for (const route of LIVE_ROUTES) {
    const items = groups[route] || [];
    if (!items.length) continue;
    const hint = route === 'human:individual'
      ? ' ⚠ TYTO JSI SCHVÁLIL TY OSOBNĚ — rozhodni zvlášť'
      : route.startsWith('assisted') ? ' (schváleno hromadně/asistovaně)' : ' (auto-schválila noční triáž)';
    p(`### ${route} — ${items.length}${hint}`);
    for (const { id, l, f } of items) {
      const sym = Array.isArray(l.symptoms) ? l.symptoms.join(', ') : (l.symptoms || '');
      p(`- **${l.vehicle_brand || '?'} ${l.vehicle_model || ''}** — ${sym}`.trimEnd());
      p(`  - klauzule (${f.clause}), jistota ${f.confidence}${f.reason ? `: ${f.reason}` : ''}`);
      p(`  - oprava: ${(l.resolution || '').replace(/\s+/g, ' ').slice(0, 140)}`);
      if (l.thread_url) p(`  - vlákno: ${l.thread_url}`);
      p(`  - local_id: ${id}`);
    }
    p('');
  }
  p('## Jak rozhodnout');
  p('- Řekni v Claude Code: „zaraď do karantény případy X, Y" (podle local_id nebo vozidla) — spustí se vratná karanténa (apply-proposal.mjs --revert to umí vrátit).');
  p('- Případy „human:individual" jsi schválil ty — u nich rozhodni vědomě (nejsou to chyby automatiky).');

  const out = L.join('\n');
  console.log(out);
  if (OUT) { writeFileSync(OUT, out); console.log(`\n(zapsáno do ${OUT})`); }
}

run();
