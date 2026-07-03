/**
 * prune-thread-text.mjs — one-off cleanup of dead thread_text on discarded
 * threads (review 2026-07-02).
 *
 * The discard path used to store the full normalized thread text on every
 * discarded thread. Nothing ever reads it again: every thread_text consumer
 * (verify, triage, recall-watchdog, precision-auditor) reaches the text via
 * CASES, and discarded threads have no cases. Result: ~33 MB of dead text
 * (~60 % of agent.db) growing ~5 MB/night. The discard path no longer stores
 * it; this tool clears the historical rows and compacts the file.
 *
 * Safety: only rows with status='discarded' AND no case referencing them are
 * touched (the case guard is defensive — there should be none). NOT reversible,
 * but the text is re-fetchable from the web: any later re-judge (recover /
 * revive) re-fetches the thread anyway.
 *
 * Usage (dry-run unless --apply):
 *   node --experimental-sqlite scripts/agent/prune-thread-text.mjs
 *   node --experimental-sqlite scripts/agent/prune-thread-text.mjs --apply
 */

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { statSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'agent.db');
const APPLY = process.argv.includes('--apply');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout=30000');

const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';

const stats = db.prepare(`
  SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(thread_text)), 0) AS bytes
  FROM threads
  WHERE status = 'discarded' AND thread_text IS NOT NULL
    AND id NOT IN (SELECT thread_id FROM cases WHERE thread_id IS NOT NULL)
`).get();
const withCases = db.prepare(`
  SELECT COUNT(*) AS n FROM threads
  WHERE status = 'discarded' AND thread_text IS NOT NULL
    AND id IN (SELECT thread_id FROM cases WHERE thread_id IS NOT NULL)
`).get();

console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} — dead thread_text on discarded threads:`);
console.log(`  prunable rows: ${stats.rows} (${mb(stats.bytes)})`);
console.log(`  discarded-with-cases (kept, expected 0): ${withCases.n}`);
console.log(`  db file before: ${mb(statSync(DB_PATH).size)}`);

if (!APPLY) {
  console.log('\nDry-run only. Re-run with --apply to clear the text and VACUUM.');
  db.close();
  process.exit(0);
}

db.prepare(`
  UPDATE threads SET thread_text = NULL
  WHERE status = 'discarded' AND thread_text IS NOT NULL
    AND id NOT IN (SELECT thread_id FROM cases WHERE thread_id IS NOT NULL)
`).run();
console.log('  text cleared; compacting (VACUUM)...');
db.exec('VACUUM');
db.close();
console.log(`  db file after: ${mb(statSync(DB_PATH).size)}`);
