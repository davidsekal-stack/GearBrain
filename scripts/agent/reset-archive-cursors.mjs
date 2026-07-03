/**
 * reset-archive-cursors.mjs — one-off recovery of forums whose archive walk was
 * FALSELY marked complete (review 2026-07-02).
 *
 * Root cause: `findNextPageLink` did not know the WoltLab (<link rel="next"> in
 * the head) and SMF (navPages » anchor) pagination patterns, so every section
 * was marked `done` after listing page 1 and the whole forum flipped to
 * "archive complete" (then 30-day parking + head-scans only). Signature in the
 * cursor: complete=true with barely more walked pages than sections
 * (RenaultForum.net: 43 sections × exactly 1 page).
 *
 * This tool finds forums with that signature and clears their archive cursor so
 * the nightly deep walk re-enumerates from page 1 — now WITH the fixed
 * pagination detection. Re-walking page 1 is cheap: already-known threads are
 * skipped by the crawled-index + local thread dedup before any LLM call.
 * `exhausted` forums are re-activated and their cooldown cleared.
 *
 * Usage (dry-run unless --apply):
 *   node --experimental-sqlite scripts/agent/reset-archive-cursors.mjs
 *   node --experimental-sqlite scripts/agent/reset-archive-cursors.mjs --apply
 *   node --experimental-sqlite scripts/agent/reset-archive-cursors.mjs --revert <backup.json>
 *
 * Selection: cursor exists AND cursor.complete AND totalPages <= sections + 2.
 * REVERSIBLE: --apply writes a backup JSON with the prior cursor/status/cooldown;
 * --revert restores rows whose cursor is still NULL (never clobbers a re-walk
 * that has already made progress).
 */

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'agent.db');

const APPLY = process.argv.includes('--apply');
const REVERT_FILE = (() => { const i = process.argv.indexOf('--revert'); return i === -1 ? null : process.argv[i + 1]; })();

function safeParse(json) {
  try { return JSON.parse(json); } catch { return null; }
}

function cursorStats(cursor) {
  const sections = Object.entries(cursor?.sections || {});
  const totalPages = sections.reduce((a, [, s]) => a + (s?.pages || 0), 0);
  return { sectionCount: sections.length, totalPages };
}

function revert(db, file) {
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`Reverting ${backup.length} forum(s) from ${file}...`);
  let restored = 0, skipped = 0;
  for (const b of backup) {
    const row = db.prepare('SELECT archive_cursor_json FROM forums WHERE id = ?').get(b.id);
    if (!row) { skipped++; continue; }
    // Only restore if the cursor is still cleared — never clobber a re-walk
    // that has already recorded new progress.
    if (row.archive_cursor_json != null) {
      console.log(`  – skip ${b.url} (walk already progressed)`);
      skipped++;
      continue;
    }
    db.prepare('UPDATE forums SET archive_cursor_json = ?, status = ?, cooldown_until = ? WHERE id = ?')
      .run(b.archive_cursor_json, b.status, b.cooldown_until, b.id);
    console.log(`  ↩ ${b.url}`);
    restored++;
  }
  console.log(`Done: ${restored} restored, ${skipped} skipped.`);
}

function run() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout=30000');

  if (REVERT_FILE) { revert(db, REVERT_FILE); db.close(); return; }

  const rows = db.prepare(`
    SELECT id, name, url, status, cooldown_until, archive_cursor_json
    FROM forums
    WHERE archive_cursor_json IS NOT NULL
  `).all();

  const suspicious = [];
  for (const r of rows) {
    const cursor = safeParse(r.archive_cursor_json);
    if (!cursor?.complete) continue;
    const { sectionCount, totalPages } = cursorStats(cursor);
    if (sectionCount === 0) continue;
    if (totalPages <= sectionCount + 2) {
      suspicious.push({ ...r, sectionCount, totalPages });
    }
  }

  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} — ${suspicious.length} forum(s) with a false-complete signature (complete=true, pages ≈ sections):\n`);
  for (const f of suspicious) {
    console.log(`  ${f.status.padEnd(11)} ${f.name || f.url}`);
    console.log(`              ${f.totalPages} page(s) / ${f.sectionCount} section(s), cooldown_until=${f.cooldown_until || '—'}`);
  }

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to clear these cursors (reversible, backup is written).');
    db.close();
    return;
  }

  const backupDir = join(__dirname, `.archive-cursor-backup-${new Date().toISOString().slice(0, 10)}`);
  mkdirSync(backupDir, { recursive: true });
  const backupFile = join(backupDir, 'backup.json');
  writeFileSync(backupFile, JSON.stringify(
    suspicious.map(f => ({
      id: f.id, url: f.url, status: f.status,
      cooldown_until: f.cooldown_until, archive_cursor_json: f.archive_cursor_json,
    })), null, 2));

  const update = db.prepare(`
    UPDATE forums
    SET archive_cursor_json = NULL,
        cooldown_until = NULL,
        status = CASE WHEN status = 'exhausted' THEN 'active' ELSE status END
    WHERE id = ?
  `);
  let reset = 0;
  for (const f of suspicious) { update.run(f.id); reset++; }

  console.log(`\nDone: ${reset} cursor(s) cleared, cooldowns removed, exhausted → active.`);
  console.log(`Backup: ${backupFile}`);
  console.log(`Undo:   node --experimental-sqlite scripts/agent/reset-archive-cursors.mjs --revert "${backupFile}"`);
  db.close();
}

run();
