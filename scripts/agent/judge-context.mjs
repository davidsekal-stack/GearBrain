/**
 * judge-context.mjs — shared prompt context for the LLM case-judging surfaces
 * (triage.mjs, precision-auditor.mjs, recall-watchdog.mjs, audit-clause-d.mjs).
 * The live verify.mjs gate already inlines its own equivalent anchor; this module exists so
 * the OTHER judges stop drifting from it (the quality-bar.mjs lesson). Two responsibilities:
 *
 *  1. caseAnchorBlock(payload) — the CASE AUTHOR + CITED POSTS anchor. On a multi-participant
 *     thread the case's true owner is payload.case_author, NOT the thread starter; without
 *     this a cheap judge conflates them and cannot locate the owner's confirmation — the root
 *     cause of the clause-(d) over-flagging. Mirrors verify.mjs's 2026-06 anchor. It does NOT
 *     assert WHERE the confirmation is (no confirmation-post line) — the model must still find
 *     it itself, preserving independence from the extractor's clause-(d) call.
 *
 *  2. windowThread(threadText, opts) — post-aware windowing. Below fullCap the WHOLE thread is
 *     sent (no behaviour change for normal threads). Above it, the window ALWAYS keeps every
 *     post by the case author (their LATER posts carry the confirmation AND any retraction —
 *     the owner's LAST word decides clause (d)), the cited fault/resolution/confirmation posts
 *     (+/-1 neighbour), and the original complaint (post 1); the uninvolved middle is elided
 *     with a marker, and the fill draws from BOTH ends so a late "fault returned" stays visible.
 *     Returns { text, coverageComplete }: coverageComplete=false means the budget forced
 *     dropping an owner/cited post (or the thread could not be safely parsed), so the CALLER
 *     MUST fall back to the safe verdict (never auto-approve on an incompletely-seen thread).
 *
 * SECURITY: the thread is untrusted forum content. Windowing must not trust an in-band
 * "POST n | ..." header that a post body could forge. parsePosts requires the STRICT
 * structured header shape AND strictly-increasing 1..N numbering (how buildThreadText emits
 * it); any anomaly (missing/duplicate/forged header) → parsePosts returns null and windowThread
 * falls back to a head+tail slice with coverageComplete=false (fail safe, never a mis-windowed
 * slice). Cited post NUMBERS are coerced to ints and range-checked. All interpolated case
 * fields go through promptField/promptList (whitespace-collapse + length-cap).
 */
import { promptField, promptList } from './prompt-sanitize.mjs';

export const JUDGE_FULL_CAP = 150_000;  // send the whole thread up to here (matches verify.mjs cap)
const MARGIN = 800;                      // headroom under fullCap for header + gap markers

// The exact structured header buildThreadText (parsers/common.mjs) emits, at column 0:
//   POST <n> | page: <p> | author: <name> | is_thread_author: <true|false>[ | when: ...][ | post_id: ...]:
const HEADER_RE = /^POST (\d+) \| page: [^\n|]*\| author: ([^\n|]*)\| is_thread_author: (true|false)/;

function normAuthor(s) { return (s ?? '').toString().toLowerCase().replace(/\s+/g, ' ').trim(); }

function headTail(txt, cap) {
  const half = Math.max(0, Math.floor((cap - 60) / 2));
  return `${txt.slice(0, half)}\n[…zkráceno (vlákno nešlo bezpečně rozčlenit)…]\n${txt.slice(-half)}`;
}

/**
 * Parse the normalized thread text into posts by the STRICT header. Returns
 * { posts:[{num,author,isThreadAuthor,start,end}], header } or null if headers are absent,
 * out of order, or non-monotonic (a forged/duplicate header) — the caller then fails safe.
 * A genuine buildThreadText header is ALWAYS preceded by a blank line; requiring that (plus
 * strict 1..N numbering) rejects a header-shaped line embedded mid-body (in-band forge).
 */
export function parsePosts(threadText) {
  const txt = threadText || '';
  const posts = [];
  let offset = 0;
  let expected = 0;
  let prevBlank = true; // start-of-text is a boundary
  for (const line of txt.split('\n')) {
    const m = HEADER_RE.exec(line);
    if (m && prevBlank) {
      expected++;
      if (Number(m[1]) !== expected) return null; // desync (forged/duplicate header) -> fail safe
      posts.push({ num: expected, author: (m[2] || '').trim(), isThreadAuthor: m[3] === 'true', start: offset, end: txt.length });
    }
    prevBlank = line.trim() === '';
    offset += line.length + 1; // +1 for the '\n' consumed by split
  }
  if (posts.length === 0) return null;
  for (let i = 0; i < posts.length - 1; i++) posts[i].end = posts[i + 1].start;
  return { posts, header: txt.slice(0, posts[0].start) };
}

/**
 * Post-aware windowing. INVARIANT: the returned text is ALWAYS <= fullCap, and
 * coverageComplete===true means the judge sees the WHOLE returned window with every
 * decision-relevant post (post 1 + all case_author posts + all cited posts) inside it — so a
 * caller may safely auto-approve only when coverageComplete is true. If everything
 * decision-relevant cannot fit under fullCap, or the owner cannot be anchored on a windowed
 * thread, or the thread cannot be safely parsed, coverageComplete is false (route to a human).
 * @returns {{text:string, coverageComplete:boolean}}
 */
export function windowThread(threadText, opts = {}) {
  const {
    caseAuthor = '', faultPostNumbers = [], resolutionPostNumbers = [], confirmationPostNumber = null,
    fullCap = JUDGE_FULL_CAP,
  } = opts;
  const txt = threadText || '';
  if (txt.length <= fullCap) return { text: txt, coverageComplete: true };

  const parsed = parsePosts(txt);
  if (!parsed) return { text: headTail(txt, fullCap), coverageComplete: false };
  const { posts, header } = parsed;
  const byNum = new Map(posts.map(p => [p.num, p]));
  const size = (n) => { const p = byNum.get(n); return p ? p.end - p.start : 0; };

  const validCited = (arr) => (Array.isArray(arr) ? arr : []).map(Number).filter(n => Number.isInteger(n) && byNum.has(n));
  const cited = new Set([...validCited(faultPostNumbers), ...validCited(resolutionPostNumbers), ...validCited([confirmationPostNumber])]);
  const citedCtx = new Set();
  for (const n of cited) { citedCtx.add(n); if (byNum.has(n - 1)) citedCtx.add(n - 1); if (byNum.has(n + 1)) citedCtx.add(n + 1); }

  const author = normAuthor(caseAuthor);
  const ownerNums = author ? posts.filter(p => normAuthor(p.author) === author).map(p => p.num) : [];

  // Budgeted selection: every add is checked against the remaining budget so the assembled
  // window can NEVER exceed fullCap. A skipped DECISION-RELEVANT post (owner or cited) means we
  // could not fully verify the case -> coverageComplete=false.
  let budget = fullCap - header.length - MARGIN;
  const chosen = new Set();
  let complete = true;
  const keep = (n, critical) => {
    if (!byNum.has(n) || chosen.has(n)) return;
    if (size(n) <= budget) { chosen.add(n); budget -= size(n); }
    else if (critical) complete = false;
  };

  // Priority (most decision-relevant first, so the owner's verdict survives budget pressure):
  keep(1, true);                                   // original complaint
  if (ownerNums.length) {
    keep(ownerNums[ownerNums.length - 1], true);   // owner's LAST word (confirmation / retraction)
    keep(ownerNums[0], true);                       // owner's first post
  }
  for (const n of cited) keep(n, true);            // cited fault/resolution/confirmation posts
  for (const n of citedCtx) if (!cited.has(n)) keep(n, false); // neighbours (nice-to-have)
  for (const n of ownerNums) keep(n, true);        // remaining owner posts

  // No resolvable owner on a windowed thread -> cannot guarantee the owner's last word is shown.
  if (ownerNums.length === 0) complete = false;

  // FILL remaining budget from BOTH ends (a late "fault returned" stays visible even if not cited).
  const order = [];
  for (let a = 1, b = posts.length; a <= b; a++, b--) { order.push(a); if (b !== a) order.push(b); }
  for (const n of order) { if (budget <= 0) break; keep(n, false); }

  const idxs = [...chosen].sort((a, b) => a - b);
  let out = header;
  let prev = null;
  for (const n of idxs) {
    if (prev !== null && n !== prev + 1) out += `\n[…vynecháno ${n - prev - 1} příspěvků…]\n`;
    out += txt.slice(byNum.get(n).start, byNum.get(n).end);
    prev = n;
  }
  // Belt-and-suspenders: never emit over fullCap (budgeting should already ensure this).
  if (out.length > fullCap) { out = `${out.slice(0, fullCap - 40)}\n[…zkráceno…]`; complete = false; }
  return { text: out, coverageComplete: complete };
}

/** The CASE AUTHOR + CITED POSTS anchor block (sanitized). Mirrors verify.mjs's anchor; does
 *  NOT reveal the confirmation post (keeps the judge independent of the extractor's (d) call). */
export function caseAnchorBlock(payload = {}) {
  const author = promptField(payload.case_author || 'unknown', 80);
  const faultPosts = promptList(payload.fault_post_numbers, 10, 'unknown');
  const resoPosts = promptList(payload.resolution_post_numbers, 10, 'unknown');
  return `The thread is a list of posts; each starts with a header line:
  POST <n> | page: <p> | author: <name> | is_thread_author: <true|false> ...:
This CASE was built from SPECIFIC posts. The CASE AUTHOR is the car's OWNER — NOT necessarily the person who STARTED the thread. Anchor your judgement to the CASE AUTHOR's OWN posts about ONE vehicle: the VEHICLE and the FAULT must come from the CASE AUTHOR's posts, and the repair counts as CONFIRMED only if the CASE AUTHOR THEMSELVES states in a LATER post that the fault is gone / the car works. The repair may be provided or carried out by ANOTHER user (a helper or mechanic) — that is fine — but another user reporting success on THEIR OWN car is NOT confirmation of this case, and a repair that was merely suggested, or done with the outcome never stated by the case author, is NOT confirmed. CHECK THE CASE AUTHOR'S LATER POSTS: if they say the fault RETURNED, came back, or the repair did NOT hold, the case is NOT confirmed even if an earlier post sounded positive. Threads often discuss several different cars and problems; IGNORE everything that is not in the cited posts or about the cited author's car.
  CASE AUTHOR: ${author}
  FAULT POSTS: ${faultPosts}
  RESOLUTION POSTS: ${resoPosts}`;
}
