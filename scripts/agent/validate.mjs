/**
 * validate.mjs — L4 deterministic gates for the autonomous crawl agent.
 *
 * Pure validation logic: no API calls, no side effects.
 * Checks extracted case completeness and quality before independent AI verification.
 *
 * Usage:
 *   import { validateCase, isCompleteRecord } from './validate.mjs';
 */

// ---------------------------------------------------------------------------
// Unresolved resolution patterns — future tense / planned actions
// ---------------------------------------------------------------------------

const UNRESOLVED_RESOLUTION_PATTERNS = [
  /\bnap[ií][sš]u\b.{0,50}\b(?:jak|az|až)\b.{0,40}\bdopadlo\b/i,
  /\b(?:z[ií]tra|tomorrow)\b.{0,60}\b(?:bude|by mělo být|should be|will be)\b.{0,20}\bok\b/i,
  /\b(?:dnes|today)\b.{0,60}\b(?:odvezl|odvezla|took it in|taken in)\b.{0,80}\b(?:opravu|repair)\b/i,
  /\b(?:pl[aá]nuj(?:i|e)|planning to|plan to)\b.{0,80}\b(?:servis|service|electrician|repair|opravu)\b/i,
  /\b(?:will|nap[ií][sš]u)\b.{0,40}\b(?:update|let you know|report back)\b/i,
];

function hasUnresolvedResolutionLanguage(resolution) {
  const text = (resolution ?? '').toString().trim();
  if (!text) return false;
  return UNRESOLVED_RESOLUTION_PATTERNS.some(pattern => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Completeness check
// ---------------------------------------------------------------------------

/**
 * Check if a record has all required fields for import.
 */
export function isCompleteRecord(rec) {
  if (!rec) return false;

  const brand = (rec.brand_raw || rec.vehicle_brand || '').trim();
  const model = (rec.model_raw || rec.vehicle_model || '').trim();
  const symptoms = Array.isArray(rec.symptoms) ? rec.symptoms.filter(s => s && s.trim()) : [];
  const description = (rec.description || '').trim();
  const resolution = (rec.resolution || '').trim();

  return (
    brand.length > 0 &&
    model.length > 0 &&
    symptoms.length >= 1 &&
    description.length > 0 &&
    resolution.length > 0
  );
}

// ---------------------------------------------------------------------------
// Post-author consistency validation
// ---------------------------------------------------------------------------

function parsePostMetaFromThreadText(threadText) {
  const map = new Map();
  for (const line of (threadText ?? '').toString().split(/\r?\n/)) {
    const match = line.match(/^POST\s+(\d+)\s*\|\s*(.+):\s*$/);
    if (!match) continue;
    const postNumber = Number(match[1]);
    const meta = match[2] ?? '';
    const authorMatch = meta.match(/\bauthor:\s*([^|]+?)(?=\s*\||$)/i);
    const isThreadAuthorMatch = meta.match(/\bis_thread_author:\s*(true|false)/i);
    if (!Number.isInteger(postNumber) || postNumber <= 0) continue;
    map.set(postNumber, {
      author: authorMatch?.[1]?.trim() ?? '',
      is_thread_author: isThreadAuthorMatch?.[1] === 'true',
    });
  }
  return map;
}

function normalizeText(s) {
  return (s ?? '')
    .toString()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Validate that the FAULT posts belong to the case author (the car's owner) — this
 * anchors the case to ONE real vehicle. The RESOLUTION may be posted by ANOTHER user
 * (a helper or mechanic), so resolution-post authorship is intentionally NOT required
 * to match — only that the cited resolution posts exist (owner policy: the author need
 * not be the one who carried out the repair; the fix is often posted by someone else).
 */
function validateCaseAuthor(item, postMetaByNumber) {
  if (!Array.isArray(item.fault_post_numbers) || item.fault_post_numbers.length === 0) {
    return { valid: false, reason: 'Missing fault_post_numbers' };
  }
  if (!Array.isArray(item.resolution_post_numbers) || item.resolution_post_numbers.length === 0) {
    return { valid: false, reason: 'Missing resolution_post_numbers' };
  }

  // Determine expected author
  const caseAuthor = (item.case_author || '').trim();
  if (!caseAuthor) {
    return { valid: false, reason: 'Missing case_author' };
  }

  const normAuthor = normalizeText(caseAuthor);

  // Check fault posts
  for (const pn of item.fault_post_numbers) {
    const postNumber = Number(pn);
    if (!Number.isInteger(postNumber) || postNumber <= 0) {
      return { valid: false, reason: `Invalid fault post number: ${pn}` };
    }
    const meta = postMetaByNumber.get(postNumber);
    if (!meta) {
      return { valid: false, reason: `Fault post ${pn} not found in thread` };
    }
    if (meta && meta.author && normalizeText(meta.author) !== normAuthor) {
      return { valid: false, reason: `Fault post ${pn} author mismatch: expected "${caseAuthor}", got "${meta.author}"` };
    }
  }

  // Check resolution posts EXIST and are well-formed, but DO NOT require the same
  // author: the fix is often posted by a helper/mechanic, not the car's owner.
  for (const pn of item.resolution_post_numbers) {
    const postNumber = Number(pn);
    if (!Number.isInteger(postNumber) || postNumber <= 0) {
      return { valid: false, reason: `Invalid resolution post number: ${pn}` };
    }
    if (!postMetaByNumber.get(postNumber)) {
      return { valid: false, reason: `Resolution post ${pn} not found in thread` };
    }
  }

  return { valid: true, reason: '' };
}

// ---------------------------------------------------------------------------
// Confirmation-quote anchor (clause (d): owner confirmed the fix worked)
// ---------------------------------------------------------------------------

// Whitespace-collapse + lowercase, faithful to the thread text (keeps
// punctuation) — same normalization the triage/audit quote-verifiers use, so a
// verbatim excerpt matches but a paraphrase/fabrication does not.
function normalizeForQuote(s) {
  return (s ?? '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
}

const MIN_CONFIRMATION_QUOTE_CHARS = 8;

/**
 * Machine-check clause (d): if the extractor claims an owner confirmation, it
 * must be REAL and by the OWNER. Returns a reason string to REJECT, or null.
 *
 * HARD-blocks the two leak classes the verifier's prose let through (measured
 * 28/70 wrongly-approved, 2026-07): a confirmation quote copied from a DIFFERENT
 * user's post (borrowed from someone else's car), and a fabricated confirmation
 * that isn't in the thread at all. A MISSING confirmation is NOT blocked here —
 * that call is left to the (now tightened, always-on) verify.mjs semantic gate,
 * so a mere extractor omission can't crater recall to zero.
 */
function confirmationReason(item, postMetaByNumber, bodies) {
  const rawPost = item.confirmation_post_number;
  const quote = (item.confirmation_quote ?? '').toString().trim();
  const hasPost = rawPost != null && rawPost !== '';
  const hasQuote = quote.length > 0;

  // Nothing claimed → defer to verify.mjs (do not block deterministically).
  if (!hasPost && !hasQuote) return null;

  // Partial claim (one without the other) is malformed → reject.
  if (hasPost !== hasQuote) {
    return 'Confirmation is incomplete (needs BOTH a post number and a verbatim quote)';
  }

  const postNumber = Number(rawPost);
  if (!Number.isInteger(postNumber) || postNumber <= 0) {
    return `Invalid confirmation_post_number: ${rawPost}`;
  }
  const meta = postMetaByNumber.get(postNumber);
  if (!meta) {
    return `Confirmation post ${postNumber} not found in thread`;
  }

  // The confirmation MUST be the owner's own later statement, not a bystander's.
  const caseAuthor = normalizeText(item.case_author || '');
  if (caseAuthor && meta.author && normalizeText(meta.author) !== caseAuthor) {
    return `Confirmation post ${postNumber} is by "${meta.author}", not the case owner "${item.case_author}" (borrowed confirmation)`;
  }

  if (quote.length < MIN_CONFIRMATION_QUOTE_CHARS) {
    return `Confirmation quote too short (${quote.length} chars)`;
  }

  // The quote must be a verbatim excerpt of THAT post's body (anti-fabrication).
  const body = normalizeForQuote(bodies.get(postNumber) || '');
  if (!body.includes(normalizeForQuote(quote))) {
    return `Confirmation quote is not a verbatim excerpt of post ${postNumber} (possible fabrication)`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Vehicle-anchor (wrong-vehicle bleed) guard
// ---------------------------------------------------------------------------

// Parse the TITLE line and each post's BODY text from the thread dump.
function parseThreadRegions(threadText) {
  const title = ((threadText ?? '').toString().match(/^TITLE:\s*(.+)$/m)?.[1] ?? '');
  const bodies = new Map();
  let current = null;
  for (const line of (threadText ?? '').toString().split(/\r?\n/)) {
    if (/^POST\s+(\d+)\s*\|/.test(line)) {
      current = Number(line.match(/^POST\s+(\d+)/)[1]);
      bodies.set(current, '');
      continue; // header line itself is not body
    }
    if (current != null) bodies.set(current, `${bodies.get(current)} ${line}`);
  }
  return { title, bodies };
}

// Since resolution posts may now be authored by a helper, the deterministic
// author backstop no longer incidentally bounds the vehicle to owner-authored
// text. This guard restores that: the case vehicle's MODEL must be grounded in
// the OWNER's own region (TITLE + fault posts + any post by case_author). It
// FAILS only the precise wrong-vehicle bleed signature — the model appears ONLY
// in a DIFFERENT author's resolution post and nowhere in the owner region — so it
// never trips section-only / title-only cases (where the model isn't in a helper
// post either). Token-set membership avoids substring false matches.
function vehicleBleedReason(item, threadText, postMetaByNumber) {
  const model = normalizeText(item.model_raw || item.vehicle_model || '');
  const modelTokens = model.split(' ').filter(t => t.length >= 2);
  if (!modelTokens.length) return null;

  const { title, bodies } = parseThreadRegions(threadText);
  const caseAuthor = normalizeText(item.case_author || '');
  const faultSet = new Set((item.fault_post_numbers || []).map(Number));

  let ownerText = ` ${normalizeText(title)} `;
  for (const [pn, body] of bodies) {
    const meta = postMetaByNumber.get(pn);
    const isOwnerPost = meta && caseAuthor && normalizeText(meta.author) === caseAuthor;
    if (faultSet.has(pn) || isOwnerPost) ownerText += ` ${normalizeText(body)} `;
  }
  const ownerTokens = new Set(ownerText.split(' ').filter(Boolean));
  if (modelTokens.some(t => ownerTokens.has(t))) return null; // grounded in owner text → fine

  // model absent from owner region — is it present in a DIFFERENT author's resolution post?
  for (const pn of (item.resolution_post_numbers || []).map(Number)) {
    const meta = postMetaByNumber.get(pn);
    if (!(meta && caseAuthor && normalizeText(meta.author) !== caseAuthor)) continue;
    const bodyTokens = new Set(normalizeText(bodies.get(pn) || '').split(' ').filter(Boolean));
    if (modelTokens.some(t => bodyTokens.has(t))) {
      return `Vehicle model "${item.model_raw}" appears only in a different author's resolution post (post ${pn}), not the owner's fault posts/title — possible wrong-vehicle bleed`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main validation gate
// ---------------------------------------------------------------------------

/**
 * Validate a single extracted case against deterministic quality gates.
 *
 * @param {object} caseData - Extracted case from DeepSeek
 * @param {object} [options]
 * @param {string} [options.threadText] - Original thread text for author validation
 * @param {object} [options.classifierResult] - Classifier result for cross-check
 * @returns {{ valid: boolean, reason: string, warnings: string[] }}
 */
export function validateCase(caseData, options = {}) {
  const warnings = [];

  // Gate 1: Completeness
  if (!isCompleteRecord(caseData)) {
    const missing = [];
    if (!(caseData.brand_raw || caseData.vehicle_brand || '').trim()) missing.push('brand');
    if (!(caseData.model_raw || caseData.vehicle_model || '').trim()) missing.push('model');
    if (!Array.isArray(caseData.symptoms) || caseData.symptoms.filter(s => s?.trim()).length === 0) missing.push('symptoms');
    if (!(caseData.description || '').trim()) missing.push('description');
    if (!(caseData.resolution || '').trim()) missing.push('resolution');
    return { valid: false, reason: `Incomplete record: missing ${missing.join(', ')}`, warnings };
  }

  // Gate 2: Unresolved resolution language
  if (hasUnresolvedResolutionLanguage(caseData.resolution)) {
    return { valid: false, reason: 'Resolution contains future/planned language — not actually resolved', warnings };
  }

  // Gate 3: Resolution minimum quality
  const resolution = (caseData.resolution || '').trim();
  if (resolution.length < 15) {
    return { valid: false, reason: `Resolution too short (${resolution.length} chars)`, warnings };
  }

  // Gate 4: Description minimum quality
  const description = (caseData.description || '').trim();
  if (description.length < 15) {
    return { valid: false, reason: `Description too short (${description.length} chars)`, warnings };
  }

  // Gate 5: Author consistency + vehicle anchor (if thread text provided)
  if (options.threadText) {
    const postMeta = parsePostMetaFromThreadText(options.threadText);
    if (postMeta.size > 0) {
      const authorCheck = validateCaseAuthor(caseData, postMeta);
      if (!authorCheck.valid) {
        return { valid: false, reason: authorCheck.reason, warnings };
      }
      // The vehicle must be grounded in the owner's own text, not lifted from a
      // helper's resolution post that may name a different car.
      const bleed = vehicleBleedReason(caseData, options.threadText, postMeta);
      if (bleed) return { valid: false, reason: bleed, warnings };

      // Clause (d): a CLAIMED owner-confirmation must be real and by the owner.
      // (A missing one is deferred to verify.mjs, not blocked here.)
      const { bodies } = parseThreadRegions(options.threadText);
      const confReason = confirmationReason(caseData, postMeta, bodies);
      if (confReason) return { valid: false, reason: confReason, warnings };
      if (!caseData.confirmation_quote) {
        warnings.push('No owner confirmation quote extracted (verifier will judge clause d)');
      }
    }
  }

  // Warnings (non-blocking)
  if (!Array.isArray(caseData.obd_codes) || caseData.obd_codes.length === 0) {
    warnings.push('No OBD codes extracted');
  }
  if (!caseData.mileage) {
    warnings.push('No mileage extracted');
  }
  if (!(caseData.engine_raw || '').trim()) {
    warnings.push('No engine info extracted');
  }

  return { valid: true, reason: '', warnings };
}
