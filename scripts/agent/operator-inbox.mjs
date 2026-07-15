/**
 * operator-inbox.mjs — the ONE owner-facing channel for the autonomous crawl agent.
 *
 * The owner does not watch Desktop markers, logs, or reports and never reviews cases. So the
 * automated pipeline must surface — in plain Czech — only the RARE, RECURRING problems that
 * genuinely need a human decision, each with an optional proposed fix. Claude reads the rendered
 * `operator-inbox.md` at the START of every session (see CLAUDE.md) and leads with it: either
 * "vše běží" or "hele, tohle se opakuje, navrhuju X — jo/ne".
 *
 * Source of truth is operator-inbox.json (structured, for the automated writers); every mutation
 * re-renders operator-inbox.md (human-readable, for Claude to relay). Issues are keyed and
 * de-duplicated; raising the same key on a NEW day bumps its day-count so genuinely RECURRING
 * problems stand out from one-offs. An issue is removed the moment its condition clears.
 *
 * CLI (called by run-coach-batch.ps1 and by hand):
 *   node operator-inbox.mjs raise --key K --title T [--detail D] [--fix F]
 *   node operator-inbox.mjs clear --key K
 *   node operator-inbox.mjs list
 *   node operator-inbox.mjs render
 */

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JSON_PATH = join(__dirname, 'operator-inbox.json');
const MD_PATH = join(__dirname, 'operator-inbox.md');

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function loadInbox() {
  if (!existsSync(JSON_PATH)) return { issues: {} };
  try {
    const o = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    return o && typeof o === 'object' && o.issues ? o : { issues: {} };
  } catch { return { issues: {} }; }
}

function saveInbox(inbox) {
  writeFileSync(JSON_PATH, JSON.stringify(inbox, null, 2), 'utf8');
  writeFileSync(MD_PATH, render(inbox), 'utf8');
}

/** Pure: raise (or refresh) an issue on an in-memory inbox. Idempotent within a day; a new day
 *  bumps the distinct-day counter so a recurring problem stands out from a one-off. */
export function applyRaise(inbox, { key, title, detail = '', fix = '' }, now = new Date()) {
  if (!key || !title) throw new Error('applyRaise needs key + title');
  const today = todayStr(now);
  const nowIso = now.toISOString();
  const cur = inbox.issues[key];
  if (cur) {
    if (cur.lastDay !== today) { cur.days = (cur.days || 1) + 1; cur.lastDay = today; }
    cur.lastSeen = nowIso;
    cur.title = title;
    if (detail) cur.detail = detail;
    if (fix) cur.fix = fix;
  } else {
    inbox.issues[key] = { key, title, detail, fix, firstSeen: nowIso, firstDay: today, lastSeen: nowIso, lastDay: today, days: 1 };
  }
  return inbox;
}

/** Pure: clear an issue. Returns true if something was removed. */
export function applyClear(inbox, key) {
  if (!inbox.issues[key]) return false;
  delete inbox.issues[key];
  return true;
}

/** Raise (or refresh) an open issue, persisting + re-rendering. Returns the stored issue. */
export function raiseIssue(opts, now = new Date()) {
  const inbox = loadInbox();
  applyRaise(inbox, opts, now);
  saveInbox(inbox);
  return inbox.issues[opts.key];
}

/** Clear an issue whose condition has resolved, persisting + re-rendering. */
export function clearIssue(key) {
  const inbox = loadInbox();
  const removed = applyClear(inbox, key);
  saveInbox(inbox);
  return removed;
}

export function openIssues(inbox = loadInbox()) {
  // Most-recurring (highest day-count), then oldest first.
  return Object.values(inbox.issues).sort((a, b) => (b.days - a.days) || a.firstSeen.localeCompare(b.firstSeen));
}

function humanDate(iso) { return (iso || '').slice(0, 10); }

export function render(inbox = loadInbox()) {
  const issues = openIssues(inbox);
  const L = [];
  L.push('# 📋 Co potřebuje tvé rozhodnutí', '');
  L.push('_Tento seznam si crawler udržuje sám. Když je prázdný, vše běží a nic ode mě není potřeba._', '');
  if (issues.length === 0) {
    L.push('**Nic — vše běží, žádné rozhodnutí ode mě teď není potřeba. ✅**', '');
    return L.join('\n');
  }
  for (const it of issues) {
    const recur = it.days > 1 ? `už ${it.days} dní (poprvé ${humanDate(it.firstSeen)})` : `poprvé dnes (${humanDate(it.firstSeen)})`;
    L.push(`## ⚠️ ${it.title}  ·  _${recur}_`);
    if (it.detail) L.push('', it.detail);
    if (it.fix) L.push('', `**Můj návrh:** ${it.fix}`);
    L.push('');
  }
  return L.join('\n');
}

// ── Known recurring issues ──────────────────────────────────────────────────────
// Plain-Czech text lives HERE (not passed through PowerShell args, which mangle diacritics).
// `raise --key K` with no --title uses this; `sync` maps the agent's own signal files to keys.
const KNOWN = {
  'coach-incomplete': {
    title: 'Ranní kontrolní běh se nedokončuje',
    detail: 'Noční „coach" dávka (kontroly + rozhodovací průchod) nedoběhla do konce — narazila na 4hodinový časový limit úlohy, takže poslední kroky se neprovedly.',
    fix: 'Zmenšit noční dávku (AUTO_REVIEW_MAX v .env.local, teď 50), případně prodloužit limit úlohy — aby se rozhodovací průchod do 4 h vešel.',
  },
  'crawler-stale': {
    title: 'Noční crawl možná vůbec neběžel',
    detail: 'Poslední úspěšný běh crawleru je starší než 30 hodin — buď byl počítač v noci vypnutý, nebo se zastavila úloha DriveCodexAgentBatch.',
    fix: 'Zkontroluju plánovač úloh a přihlášení; když šlo jen o vypnutý počítač, stačí ho nechat večer zapnutý.',
  },
  'verifier-strict': {
    title: 'Ověřovač možná zamítá příliš přísně',
    detail: 'Denní hlídač našel známky, že se zahazují i dobré případy (klesá výtěžnost).',
    fix: 'Podívám se na vzorek zamítnutých a případně povolím ověřovací práh (vratně).',
  },
  'precision-bad-cases': {
    title: 'Do databáze se možná dostaly špatné případy',
    detail: 'Precizní auditor našel mezi schválenými případy nějaké, které vypadají chybně.',
    fix: 'Projdu je, chybné vratně stáhnu a zpřísním tam, kde to uniklo.',
  },
};

/** Reconcile the inbox with the agent's own signal files (idempotent). Called at the end of the
 *  coach batch: a present alert file raises its issue, an absent one clears it. All text is Czech
 *  and defined in KNOWN above — nothing is passed through the shell. */
export function syncFromSignals(agentDir = __dirname, now = new Date()) {
  const inbox = loadInbox();
  const read = (name) => { try { const p = join(agentDir, name); return existsSync(p) ? readFileSync(p, 'utf8') : null; } catch { return null; } };
  const reconcile = (key, present, extra = '') => {
    if (present) applyRaise(inbox, { ...KNOWN[key], key, detail: (KNOWN[key].detail + (extra ? `\n\n${extra}` : '')).slice(0, 1200) }, now);
    else applyClear(inbox, key);
  };
  const recall = read('recall-alert.txt');
  reconcile('verifier-strict', !!(recall && recall.trim()), (recall || '').trim().slice(0, 500));
  const prec = read('precision-alert.txt');
  reconcile('precision-bad-cases', !!(prec && prec.trim()), (prec || '').trim().slice(0, 500));
  const ls = read('last-success.txt');
  let stale = false;
  if (ls && ls.trim()) { const t = Date.parse(ls.trim()); if (Number.isFinite(t)) stale = (now.getTime() - t) > 30 * 3600 * 1000; }
  reconcile('crawler-stale', stale);
  saveInbox(inbox);
  return openIssues(inbox);
}

// ── CLI ────────────────────────────────────────────────────────────────────────
function arg(flag) { const i = process.argv.indexOf(flag); return i === -1 ? null : process.argv[i + 1]; }

const invokedDirectly = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (invokedDirectly) {
  const mode = process.argv[2];
  if (mode === 'raise') {
    const key = arg('--key');
    const known = key && KNOWN[key];
    const title = arg('--title') || (known && known.title);
    if (!key || !title) { console.error('raise needs --key (and --title unless the key is known)'); process.exit(1); }
    const it = raiseIssue({ key, title, detail: arg('--detail') || (known && known.detail) || '', fix: arg('--fix') || (known && known.fix) || '' });
    console.log(`operator-inbox: raised "${key}" (day ${it.days}). → ${MD_PATH}`);
  } else if (mode === 'sync') {
    const open = syncFromSignals();
    console.log(`operator-inbox: synced from signals; ${open.length} open issue(s). → ${MD_PATH}`);
  } else if (mode === 'clear') {
    const key = arg('--key');
    if (!key) { console.error('clear needs --key'); process.exit(1); }
    const removed = clearIssue(key);
    console.log(`operator-inbox: ${removed ? 'cleared' : 'no such open issue'} "${key}". → ${MD_PATH}`);
  } else if (mode === 'list') {
    const issues = openIssues();
    console.log(issues.length ? issues.map(i => `- [${i.days}d] ${i.key}: ${i.title}`).join('\n') : '(prázdné)');
  } else if (mode === 'render') {
    saveInbox(loadInbox());
    console.log(`operator-inbox: rendered → ${MD_PATH}`);
  } else {
    console.error('mode must be: raise | sync | clear | list | render');
    process.exit(1);
  }
}
