/**
 * gold-set-prepare.mjs — READ-ONLY. Assembles a risk-stratified batch of ~20
 * APPROVED cases for the owner to hand-label (review 2026-07-02, point 2 / Phase 4).
 *
 * The owner's verdicts become the ground-truth "gold set" that calibrates the
 * triage auto-approve threshold (today the only signal is the auditors judging
 * themselves). This tool ONLY selects + lays out the cases with their evidence
 * and a verdict template; it writes NOTHING to any DB. The owner rules on each,
 * and those verdicts are recorded to logs/gold-set-labels.jsonl (via a follow-up).
 *
 * Sampling (deterministic — no RNG, reproducible): newest approved + highest
 * payload-risk (short resolution / multi-brand / missing cited posts) + an
 * even-spread backstop, deduped, capped at --n (default 20).
 *
 * Usage:
 *   node --env-file=scripts/agent/.env.local --experimental-sqlite scripts/agent/gold-set-prepare.mjs [--n 20]
 */

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolveSupabaseReadKey } from './supabase-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'agent.db');
const LOG_DIR = join(__dirname, 'logs');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nmvjthfezyjcwuzphiuu.supabase.co';
const KEY = resolveSupabaseReadKey(process.env);
const N = (() => { const i = process.argv.indexOf('--n'); return i === -1 ? 20 : Number(process.argv[i + 1]) || 20; })();

const BRAND_RE = [/\baudi\b/i, /\bbmw\b/i, /\bcitro[eë]n\b/i, /\bford\b/i, /\bhyundai\b/i, /\bkia\b/i, /\bmercedes\b/i, /\bnissan\b/i, /\bopel\b/i, /\bpeugeot\b/i, /\brenault\b/i, /\b(škoda|skoda)\b/i, /\btoyota\b/i, /\b(volkswagen|vw)\b/i, /\bvolvo\b/i, /\bfiat\b/i];
function distinctBrands(t) { const s = ` ${t || ''} `; let n = 0; for (const re of BRAND_RE) if (re.test(s)) n++; return n; }
function riskScore(p = {}) {
  let s = 0;
  const r = (p.resolution || '').toString().trim();
  if (r.length < 220) s += 3;
  if (!Array.isArray(p.resolution_post_numbers) || p.resolution_post_numbers.length === 0) s += 2;
  if (!Array.isArray(p.fault_post_numbers) || p.fault_post_numbers.length === 0) s += 1;
  if (distinctBrands(`${p.description || ''} ${p.resolution || ''}`) >= 2) s += 2;
  if (!p.confirmation_quote) s += 2;   // no owner-confirmation quote → clause (d) risk
  return s;
}

async function restGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  return r.ok ? r.json() : [];
}

async function run() {
  if (!KEY) { console.error('No Supabase read key.'); process.exit(1); }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  // Live approved cases (the population the gold set must represent).
  const live = await restGet('gearbrain_cases?status=eq.approved&select=local_id,vehicle_brand,vehicle_model,symptoms,description,resolution,thread_url,created_at&order=created_at.desc&limit=400');
  if (!live.length) { console.log('No approved cases to sample.'); db.close(); return; }

  // Enrich each with the local payload (cited posts + confirmation quote) for risk + evidence.
  const enrich = (row) => {
    const c = db.prepare('SELECT payload_json FROM cases WHERE id = ?').get(row.local_id);
    let p = {}; try { p = JSON.parse(c?.payload_json || '{}'); } catch {}
    return { ...row, payload: p, risk: riskScore({ ...p, resolution: row.resolution, description: row.description }) };
  };
  const all = live.map(enrich);

  // Deterministic stratified pick: newest, riskiest, even-spread.
  const nFresh = Math.round(N * 0.4), nRisk = Math.round(N * 0.4);
  const picked = new Map();
  const take = (arr, k) => { for (const x of arr) { if (picked.size >= N) break; if (k(x)) picked.set(x.local_id, x); } };
  take([...all], () => true && picked.size < nFresh);                              // newest (already desc)
  take([...all].sort((a, b) => b.risk - a.risk), () => picked.size < nFresh + nRisk); // riskiest
  const step = Math.max(1, Math.floor(all.length / N));                             // even spread backstop
  take(all.filter((_, i) => i % step === 0), () => true);
  const batch = [...picked.values()];

  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const L = [];
  L.push(`# Gold-set k ručnímu posouzení — ${today}`, '');
  L.push(`Vzorek ${batch.length} schválených případů (nejnovější + rizikové + rozptyl). U KAŽDÉHO rozhodni: **schválit / zamítnout**, a pokud zamítnout, kterou klauzuli (a)-(e) porušuje + krátká poznámka. Tvoje verdikty se stanou metrem pro ladění triáže.`, '');
  L.push('Klauzule: (a) osobák/dodávka/pickup · (b) skutečná závada opravená+potvrzená · (c) ne konfig/nákup/upgrade · (d) potvrdil MAJITEL že závada zmizela · (e) vozidlo sedí na citované příspěvky.', '');
  batch.forEach((b, i) => {
    const sym = Array.isArray(b.symptoms) ? b.symptoms.join(', ') : (b.symptoms || '');
    const conf = b.payload?.confirmation_quote ? `„${b.payload.confirmation_quote.slice(0, 160)}" (post ${b.payload.confirmation_post_number ?? '?'})` : '— žádná citace potvrzení —';
    L.push(`## ${i + 1}. ${b.vehicle_brand || '?'} ${b.vehicle_model || ''}  (risk ${b.risk})`.trimEnd());
    L.push(`- Příznaky: ${sym}`);
    L.push(`- Popis: ${(b.description || '').replace(/\s+/g, ' ').slice(0, 300)}`);
    L.push(`- Oprava: ${(b.resolution || '').replace(/\s+/g, ' ').slice(0, 300)}`);
    L.push(`- Potvrzení od majitele: ${conf}`);
    if (b.thread_url) L.push(`- Vlákno: ${b.thread_url}`);
    L.push(`- local_id: ${b.local_id}`);
    L.push(`- **Verdikt: ______  | klauzule: __ | pozn.: __________**`, '');
  });
  const out = join(LOG_DIR, `gold-set-${today}.md`);
  writeFileSync(out, L.join('\n'));
  console.log(`Gold-set připraven: ${batch.length} případů → ${out}`);
  console.log(`Rozpad rizika: ${batch.filter(b => b.risk >= 5).length} vysoké (≥5), ${batch.filter(b => b.risk > 0 && b.risk < 5).length} střední, ${batch.filter(b => b.risk === 0).length} nízké.`);
  db.close();
}

run();
