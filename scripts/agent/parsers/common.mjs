/**
 * common.mjs — Shared HTML parsing utilities for all forum parsers.
 */

// ---------------------------------------------------------------------------
// HTML → plain text
// ---------------------------------------------------------------------------

export function htmlToText(html) {
  let s = (html ?? '').toString();
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<(br|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h1|h2|h3|h4|h5|h6)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  s = s.replace(/&#(\d+);/g, (_, n) => {
    const code = Number(n);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, n) => {
    const code = parseInt(n, 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
  s = s.replace(/\r\n/g, '\n');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

export function extractTitle(html) {
  const m = (html ?? '').toString().match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  const t = htmlToText(m[1]).trim();
  // Strip only the last pipe-separated segment (usually the forum name)
  const parts = t.split(/\s*\|\s*/);
  return (parts.length > 1 ? parts.slice(0, -1).join(' | ') : t).trim();
}

// ---------------------------------------------------------------------------
// Text normalization (diacritics-safe)
// ---------------------------------------------------------------------------

export function normalizeText(s) {
  return (s ?? '')
    .toString()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Noise filter for post text lines
// ---------------------------------------------------------------------------

const NOISE_PATTERNS = [
  /^(citace|quote|l[ií]b[ií] se mi|sd[ií]let|odpov[eě]d[eě]t|report|share|like|reply|přidat komentář)$/i,
  /^(re:|odp:|fw:|fwd:)/i,
  /^(#\d+|page \d+ of \d+)$/i,
];

export function isNoiseLine(line) {
  const trimmed = (line ?? '').toString().trim();
  if (!trimmed) return true;
  const norm = normalizeText(trimmed);
  return NOISE_PATTERNS.some(p => p.test(norm) || p.test(trimmed));
}

export function cleanPostText(rawText, minLength = 40) {
  const lines = (rawText ?? '')
    .toString()
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => !isNoiseLine(x));
  const text = lines.join('\n');
  return text.length >= minLength ? text : '';
}

// ---------------------------------------------------------------------------
// Thread text assembly (POST 1 | page: ... format)
// ---------------------------------------------------------------------------

export function buildThreadText({ url, title, posts, forumTitle = '', subforumTitle = '' }) {
  const lines = [];
  if (forumTitle) lines.push(`FORUM_CONTEXT: ${forumTitle}`);
  if (subforumTitle) lines.push(`SUBFORUM_TITLE: ${subforumTitle}`);
  lines.push(`THREAD_URL: ${url}`);
  if (title) lines.push(`TITLE: ${title}`);

  const threadAuthor = posts.find(p => p.author)?.author ?? '';
  if (threadAuthor) lines.push(`THREAD_AUTHOR: ${threadAuthor}`);
  lines.push('');

  let idx = 0;
  for (const p of posts) {
    idx++;
    const isThreadAuthor = threadAuthor
      ? normalizeText(p.author) === normalizeText(threadAuthor)
      : false;
    const meta = [
      `page: ${p.pageNumber ?? 1}`,
      `author: ${p.author || 'unknown'}`,
      `is_thread_author: ${isThreadAuthor ? 'true' : 'false'}`,
      p.when ? `when: ${p.when}` : '',
      p.postId ? `post_id: ${p.postId}` : '',
    ].filter(Boolean).join(' | ');
    lines.push(`POST ${idx}${meta ? ` | ${meta}` : ''}:`);
    lines.push(p.text);
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Thread age — last-activity dating for the >=1-year crawl policy
//
// A thread is only mined once it has been quiet long enough that any fix it will
// ever get is already present (see processThread's defer gate in crawl.mjs). To
// judge that we need the date of the newest post. The engine parsers all read the
// post date from <time datetime="…"> (ISO-8601); some skins expose a numeric epoch
// in data-time. Anything localized/relative ("vor 2 Stunden", "včera") is NOT
// parsed — parseWhenToDate returns null and the caller treats unknown age as
// "process now" (the safe direction: we never silently lose a thread we can't date).
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

// EU/EN month names → 1-based month. Czech appears in both nominative and the
// genitive form used in dates ("15. března"), German with/without umlaut folding,
// English full + 3-letter. Lowercased keys; diacritics folded at lookup.
const MONTH_NAMES = (() => {
  const m = {};
  const put = (n, ...words) => { for (const w of words) m[w] = n; };
  put(1,  'leden', 'ledna', 'januar', 'january', 'jan');
  put(2,  'unor', 'unora', 'februar', 'february', 'feb');
  put(3,  'brezen', 'brezna', 'marz', 'march', 'mar', 'maerz');
  put(4,  'duben', 'dubna', 'april', 'apr');
  put(5,  'kveten', 'kvetna', 'mai', 'may');
  put(6,  'cerven', 'cervna', 'juni', 'june', 'jun');
  put(7,  'cervenec', 'cervence', 'juli', 'july', 'jul');
  put(8,  'srpen', 'srpna', 'august', 'aug');
  put(9,  'zari', 'september', 'sept', 'sep');
  put(10, 'rijen', 'rijna', 'oktober', 'october', 'oct', 'okt');
  put(11, 'listopad', 'listopadu', 'november', 'nov');
  put(12, 'prosinec', 'prosince', 'dezember', 'december', 'dec', 'dez');
  return m;
})();

function foldDiacritics(s) {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '');
}

// Build a UTC-midnight epoch from y/m/d, validating the calendar date. UTC keeps
// the result independent of the runtime timezone (deterministic); for a 1-year
// age gate the intra-day offset is irrelevant.
function ymdToUtc(y, mo, d) {
  if (!(y >= 1990 && y <= 2100) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  const ms = Date.UTC(y, mo - 1, d);
  const dt = new Date(ms);
  // Reject overflow (e.g. 31.02 → Mar 3).
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return ms;
}

/**
 * Parse a post's `when` value to epoch milliseconds, or null if it is not a
 * reliably-absolute date. Accepts, in order:
 *   - ISO-8601 (the engine <time datetime>) and bare unix epoch (10/13 digits);
 *   - EU deterministic absolute dates the calibrated date_selector exposes as
 *     visible text: `dd.mm.yyyy` / `dd. mm. yyyy` (EU dot = day-first),
 *     `yyyy-mm-dd` / `yyyy.mm.dd` (year-first), and `15. března 2024` /
 *     `15. März 2024` / `15 March 2024` / `March 15, 2024` (cs/de/en month names).
 * Everything ambiguous or relative (slash dd/mm — US vs EU, "včera", "vor 2
 * Stunden", 2-digit years) returns null = unknown age → caller processes now
 * (the safe direction: we never silently drop a thread we cannot reliably date).
 * Extending this DIRECTLY re-arms the >=1-year defer gate on the ~70 % of EU
 * threads that render text dates rather than a machine <time datetime>.
 */
export function parseWhenToDate(raw) {
  const s = (raw ?? '').toString().trim();
  if (!s) return null;
  // Bare unix epoch (seconds: 10 digits ~2001–2286, or milliseconds: 13 digits).
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  // ISO-8601 (or ISO-ish with a space) — guard against Date.parse's loose garbage.
  if (ISO_DATE_RE.test(s)) {
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) return ms;
  }

  // Take the first date-looking token out of a possibly longer visible string
  // (e.g. "st 15. 03. 2024 14:23", "Beitrag vom 15. März 2024").
  const folded = foldDiacritics(s.toLowerCase());

  // Year-first: yyyy-mm-dd / yyyy.mm.dd / yyyy/mm/dd (unambiguous).
  let m = folded.match(/\b(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\b/);
  if (m) return ymdToUtc(Number(m[1]), Number(m[2]), Number(m[3]));

  // EU dot-separated day-first: dd.mm.yyyy / dd. mm. yyyy (4-digit year required).
  // Dots (not slashes) are the EU convention → day-first is safe for our EU forums.
  m = folded.match(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\b/);
  if (m) return ymdToUtc(Number(m[3]), Number(m[2]), Number(m[1]));

  // Month-name: "15. brezna 2024" / "15 march 2024" (day month year).
  m = folded.match(/\b(\d{1,2})\.?\s+([a-z]+)\.?\s+(\d{4})\b/);
  if (m && MONTH_NAMES[m[2]]) return ymdToUtc(Number(m[3]), MONTH_NAMES[m[2]], Number(m[1]));

  // Month-name English "month day, year": "march 15, 2024".
  m = folded.match(/\b([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m && MONTH_NAMES[m[1]]) return ymdToUtc(Number(m[3]), MONTH_NAMES[m[1]], Number(m[2]));

  return null; // ambiguous (slash dd/mm), relative, or unrecognized → unknown age
}

/**
 * Newest parseable post date in a thread, as epoch milliseconds, or null when no
 * post carries a reliably-absolute timestamp (=> caller treats age as unknown).
 */
export function threadLastActivity(posts) {
  let newest = null;
  for (const p of posts ?? []) {
    const ms = parseWhenToDate(p?.when);
    if (ms != null && (newest == null || ms > newest)) newest = ms;
  }
  return newest;
}

// ---------------------------------------------------------------------------
// Extract thread links using calibrated CSS selectors
// ---------------------------------------------------------------------------

function parseTagAttrs(attrText) {
  const attrs = new Map();
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(attrText || '')) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    attrs.set(name, value);
  }
  return attrs;
}

function parseSelectorSegment(segment) {
  const trimmed = (segment ?? '').toString().trim();
  if (!trimmed || trimmed === '>' || trimmed === '+' || trimmed === '~') return null;

  const notSegments = [...trimmed.matchAll(/:not\(([^()]+)\)/g)]
    .map(m => parseSelectorSegmentBase(m[1]))
    .filter(Boolean);
  const positivePart = trimmed.replace(/:not\([^()]+\)/g, '').trim();
  const base = parseSelectorSegmentBase(positivePart);
  if (!base) {
    return notSegments.length > 0 ? { tag: null, classes: [], attrs: [], notSegments } : null;
  }
  return { ...base, notSegments };
}

function parseSelectorSegmentBase(segment) {
  const trimmed = (segment ?? '').toString().trim();
  if (!trimmed) return null;

  const selectorWithoutAttrs = trimmed.replace(/\[[^\]]+\]/g, '');
  const tagMatch = selectorWithoutAttrs.match(/^\s*([a-zA-Z][\w-]*)/);
  const tag = tagMatch ? tagMatch[1].toLowerCase() : null;
  const classes = [...selectorWithoutAttrs.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map(m => m[1]);
  const attrs = [...trimmed.matchAll(/\[([a-zA-Z0-9_:-]+)([*^$|~]?=)?(?:"([^"]*)"|'([^']*)')?\]/g)]
    .map(m => ({
      name: m[1].toLowerCase(),
      operator: m[2] ?? null,
      value: m[3] ?? m[4] ?? '',
    }));

  if (!tag && classes.length === 0 && attrs.length === 0) return null;
  return { tag, classes, attrs };
}

function attrsMatch(requiredAttrs, attrMap) {
  return requiredAttrs.every(req => {
    if (!attrMap.has(req.name)) return false;
    const actual = attrMap.get(req.name) ?? '';
    if (!req.operator) return true;
    if (req.operator === '=') return actual === req.value;
    if (req.operator === '*=') return actual.includes(req.value);
    if (req.operator === '^=') return actual.startsWith(req.value);
    if (req.operator === '$=') return actual.endsWith(req.value);
    if (req.operator === '~=') return actual.split(/\s+/).includes(req.value);
    if (req.operator === '|=') return actual === req.value || actual.startsWith(`${req.value}-`);
    return false;
  });
}

function segmentMatchesOpenTag(tagName, attrText, segment) {
  if (!segment) return false;
  if (!segmentMatchesPositiveSelector(tagName, attrText, segment)) return false;
  return !(segment.notSegments || []).some(notSegment =>
    segmentMatchesPositiveSelector(tagName, attrText, notSegment)
  );
}

function segmentMatchesPositiveSelector(tagName, attrText, segment) {
  if (!segment) return false;
  if (segment.tag && segment.tag !== tagName.toLowerCase()) return false;

  const attrMap = parseTagAttrs(attrText);
  const classes = new Set((attrMap.get('class') || '').split(/\s+/).filter(Boolean));
  if (!segment.classes.every(cls => classes.has(cls))) return false;
  return attrsMatch(segment.attrs, attrMap);
}

function selectorMatchesAnchor(selector, anchorAttrText, ancestorStack) {
  const parts = selector
    .split(/\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;

  const target = parseSelectorSegment(parts.at(-1));
  if (!target) return false;
  if (target.tag && target.tag !== 'a') return false;
  if (!segmentMatchesOpenTag('a', anchorAttrText, target)) return false;

  const ancestors = parts
    .slice(0, -1)
    .map(parseSelectorSegment)
    .filter(Boolean);
  if (ancestors.length === 0) return true;

  let stackIndex = ancestorStack.length - 1;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    let found = false;
    while (stackIndex >= 0) {
      const stackItem = ancestorStack[stackIndex];
      stackIndex--;
      if (!segmentMatchesOpenTag(stackItem.tagName, stackItem.attrText, ancestor)) continue;
      found = true;
      break;
    }
    if (!found) return false;
  }

  return true;
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

const RAW_TEXT_TAGS = new Set([
  'script', 'style', 'template', 'textarea', 'title',
]);

function popMatchingTag(stack, tagName) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].tagName !== tagName) continue;
    stack.length = i;
    return;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlAttribute(value) {
  return (value ?? '')
    .toString()
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function findTagClose(html, startIndex) {
  let quote = null;
  for (let i = startIndex; i < (html || '').length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

function findRawTextClosingTag(html, tagName, startIndex) {
  const re = new RegExp(`<\\/\\s*${escapeRegExp(tagName)}\\s*>`, 'ig');
  re.lastIndex = startIndex;
  const match = re.exec(html || '');
  return match ? { start: match.index, end: re.lastIndex } : null;
}

function tokenizeHtmlTags(html) {
  const tokens = [];
  let index = 0;
  const source = (html ?? '').toString();

  while (index < source.length) {
    const openIndex = source.indexOf('<', index);
    if (openIndex === -1) break;

    if (source.startsWith('<!--', openIndex)) {
      const commentEnd = source.indexOf('-->', openIndex + 4);
      index = commentEnd === -1 ? source.length : commentEnd + 3;
      continue;
    }

    if (source.startsWith('<![CDATA[', openIndex)) {
      const cdataEnd = source.indexOf(']]>', openIndex + 9);
      index = cdataEnd === -1 ? source.length : cdataEnd + 3;
      continue;
    }

    if (/^<![^-]/.test(source.slice(openIndex, openIndex + 3)) || source.startsWith('<?', openIndex)) {
      const declarationEnd = findTagClose(source, openIndex + 2);
      index = declarationEnd === -1 ? source.length : declarationEnd + 1;
      continue;
    }

    const tagEnd = findTagClose(source, openIndex + 1);
    if (tagEnd === -1) break;

    const fullTag = source.slice(openIndex, tagEnd + 1);
    const closeMatch = fullTag.match(/^<\s*\/\s*([a-zA-Z][\w:-]*)\s*>$/);
    if (closeMatch) {
      tokens.push({
        type: 'close',
        tagName: closeMatch[1].toLowerCase(),
        attrText: '',
        start: openIndex,
        end: tagEnd + 1,
      });
      index = tagEnd + 1;
      continue;
    }

    const openMatch = fullTag.match(/^<\s*([a-zA-Z][\w:-]*)\b([\s\S]*?)>$/);
    if (!openMatch) {
      index = openIndex + 1;
      continue;
    }

    const tagName = openMatch[1].toLowerCase();
    const attrText = openMatch[2] ?? '';
    const isSelfClosing = /\/\s*>$/.test(fullTag) || VOID_TAGS.has(tagName);

    tokens.push({
      type: 'open',
      tagName,
      attrText,
      isSelfClosing,
      start: openIndex,
      end: tagEnd + 1,
    });

    index = tagEnd + 1;

    if (!isSelfClosing && RAW_TEXT_TAGS.has(tagName)) {
      const closing = findRawTextClosingTag(source, tagName, index);
      if (closing) {
        tokens.push({
          type: 'close',
          tagName,
          attrText: '',
          start: closing.start,
          end: closing.end,
        });
        index = closing.end;
      } else {
        break;
      }
    }
  }

  return tokens;
}

function findMatchingAnchorClose(tokens, openIndex) {
  let depth = 0;
  for (let i = openIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.tagName !== 'a') continue;
    if (token.type === 'open' && !token.isSelfClosing) {
      depth++;
      continue;
    }
    if (token.type !== 'close') continue;
    if (depth === 0) return i;
    depth--;
  }
  return -1;
}

function collectAnchorsWithAncestors(html) {
  const anchors = [];
  const stack = [];
  const tokens = tokenizeHtmlTags(html);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const { tagName, attrText } = token;

    if (token.type === 'close') {
      popMatchingTag(stack, tagName);
      continue;
    }

    if (tagName === 'a') {
      const closeIndex = findMatchingAnchorClose(tokens, i);
      const innerHtml = closeIndex === -1
        ? ''
        : (html || '').slice(token.end, tokens[closeIndex].start);

      anchors.push({
        attrText,
        innerHtml,
        ancestorStack: stack.map(item => ({ ...item })),
      });

      if (closeIndex !== -1) i = closeIndex;
      continue;
    }

    if (!token.isSelfClosing) {
      stack.push({ tagName, attrText });
    }
  }

  return anchors;
}

export function extractThreadLinksBySelector(html, baseUrl, selectorList) {
  const selectors = (selectorList ?? '')
    .toString()
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (selectors.length === 0) return [];

  const links = [];
  const seen = new Set();
  for (const anchor of collectAnchorsWithAncestors(html)) {
    const attrs = anchor.attrText;
    if (!selectors.some(selector => selectorMatchesAnchor(selector, attrs, anchor.ancestorStack))) continue;

    const attrMap = parseTagAttrs(attrs);
    let href = attrMap.get('href') ?? '';
    href = decodeHtmlAttribute(href);

    const text = htmlToText(anchor.innerHtml).trim();
    if (!href || !text) continue;

    try {
      href = new URL(href, baseUrl).href;
    } catch {
      continue;
    }

    try {
      const parsed = new URL(href);
      parsed.hash = '';
      href = parsed.href;
    } catch { /* keep as-is */ }

    if (href.includes('/login') || href.includes('/register')) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    links.push({ url: href, title: text });
  }

  return links;
}

// ---------------------------------------------------------------------------
// General element selection (post containers, content/author/date sub-fields)
//
// The anchor selector above is generalized here to any element, so the
// LLM-calibrated CSS selectors (post_selector / content_selector /
// author_selector / date_selector / quote_selector) are honored by every
// parser instead of being dead config. Reuses the same tokenizer.
// ---------------------------------------------------------------------------

function findMatchingCloseTag(tokens, openIndex, tagName) {
  let depth = 0;
  for (let i = openIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.tagName !== tagName) continue;
    if (token.type === 'open' && !token.isSelfClosing) { depth++; continue; }
    if (token.type !== 'close') continue;
    if (depth === 0) return i;
    depth--;
  }
  return -1;
}

function selectorMatchesElement(selector, tagName, attrText, ancestorStack) {
  const parts = selector.split(/\s+/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return false;

  const target = parseSelectorSegment(parts.at(-1));
  if (!target) return false;
  if (!segmentMatchesOpenTag(tagName, attrText, target)) return false;

  const ancestors = parts.slice(0, -1).map(parseSelectorSegment).filter(Boolean);
  if (ancestors.length === 0) return true;

  let stackIndex = ancestorStack.length - 1;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    let found = false;
    while (stackIndex >= 0) {
      const item = ancestorStack[stackIndex];
      stackIndex--;
      if (!segmentMatchesOpenTag(item.tagName, item.attrText, ancestor)) continue;
      found = true;
      break;
    }
    if (!found) return false;
  }
  return true;
}

/**
 * Collect non-overlapping elements matching ANY selector in a comma list.
 * Returns [{ tagName, attrText, innerHtml, outerStart, outerEnd, ancestorStack }].
 * Nested matches inside a matched element are skipped (outermost wins).
 */
export function selectElements(html, selectorList) {
  const selectors = (selectorList ?? '')
    .toString()
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (selectors.length === 0) return [];

  const source = (html ?? '').toString();
  const tokens = tokenizeHtmlTags(source);
  const stack = [];
  const results = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'close') { popMatchingTag(stack, token.tagName); continue; }
    if (token.isSelfClosing) continue;

    const matched = selectors.some(sel =>
      selectorMatchesElement(sel, token.tagName, token.attrText, stack)
    );
    if (matched) {
      const closeIndex = findMatchingCloseTag(tokens, i, token.tagName);
      const outerEnd = closeIndex === -1 ? source.length : tokens[closeIndex].end;
      const innerHtml = closeIndex === -1
        ? source.slice(token.end)
        : source.slice(token.end, tokens[closeIndex].start);
      results.push({
        tagName: token.tagName,
        attrText: token.attrText,
        innerHtml,
        outerStart: token.start,
        outerEnd,
        ancestorStack: stack.map(item => ({ ...item })),
      });
      // Skip the element's interior so nested same-selector matches don't double-count
      if (closeIndex !== -1) i = closeIndex;
      continue;
    }

    stack.push({ tagName: token.tagName, attrText: token.attrText });
  }

  return results;
}

// Attributes that carry author/date values when an element has no text — e.g.
// IPS4 puts the username in `data-mentionname` on an anchor that wraps only an
// avatar image, and dates live in `datetime`/`data-time`. Ordered most-specific
// first. Without this, calibrated author_selector/date_selector silently yield
// empty strings on modern JS forums, which fails the same-author validation
// gate and discards every case.
const VALUE_BEARING_ATTRS = [
  'datetime', 'data-mentionname', 'data-author', 'data-username',
  'data-date', 'data-time', 'data-timestamp', 'content', 'title', 'aria-label', 'alt',
];

function firstElementText(html, selectorList) {
  const els = selectElements(html, selectorList);
  if (els.length === 0) return '';
  const text = htmlToText(els[0].innerHtml).trim();
  if (text) return text;
  // No text — fall back to a value-bearing attribute on the matched element.
  const attrs = parseTagAttrs(els[0].attrText);
  for (const key of VALUE_BEARING_ATTRS) {
    const v = (attrs.get(key) || '').trim();
    if (v) return v;
  }
  return '';
}

// For DATES the machine-readable attribute is canonical and the visible text is
// usually localized/relative ("25 Jun 2026", "vor 2 Stunden") — the opposite of
// authors, whose visible text IS the value. So the date reader prefers the
// `datetime`/`data-time` attribute (and a nested `<time datetime>`, mirroring the
// engine parsers) over the element text, then falls back to text. Without this,
// the calibrated-selector path (preferred by parseHtml) returned localized text
// that the thread-age gate cannot parse, making the gate inert on profiled forums.
const DATE_BEARING_ATTRS = ['datetime', 'data-time', 'data-timestamp', 'data-date'];

function firstElementDate(html, selectorList) {
  const els = selectElements(html, selectorList);
  if (els.length === 0) return '';
  const attrs = parseTagAttrs(els[0].attrText);
  for (const key of DATE_BEARING_ATTRS) {
    const v = (attrs.get(key) || '').trim();
    if (v) return v;
  }
  const nested = els[0].innerHtml.match(/<time\b[^>]*\bdatetime=(?:"|')([^"']+)(?:"|')[^>]*>/i);
  if (nested) return nested[1];
  return htmlToText(els[0].innerHtml).trim();
}

function removeElementsBySelector(html, selectorList) {
  const els = selectElements(html, selectorList).sort((a, b) => b.outerStart - a.outerStart);
  let out = (html ?? '').toString();
  for (const el of els) out = `${out.slice(0, el.outerStart)} ${out.slice(el.outerEnd)}`;
  return out;
}

function extractPostId(attrText) {
  const attrMap = parseTagAttrs(attrText);
  for (const key of ['id', 'data-content', 'data-post-id', 'data-id']) {
    const raw = attrMap.get(key);
    if (raw) {
      const num = raw.match(/\d+/);
      if (num) return num[0];
    }
  }
  return null;
}

/**
 * Extract posts using calibrated CSS selectors. Returns [] if no post_selector
 * is configured or nothing matches, so callers can fall back to engine regex.
 *
 * @param {string} html
 * @param {object} calibration - post_selector (required), content_selector,
 *   author_selector, date_selector, quote_selector, min_post_length
 * @param {number} [pageNumber=1]
 */
export function selectPosts(html, calibration = {}, pageNumber = 1) {
  const postSelector = calibration?.post_selector;
  if (!postSelector) return [];

  const minLength = Number(calibration.min_post_length) || 40;
  const containers = selectElements(html, postSelector);

  // Volitelná hlavička příspěvku v ODDĚLENÉM sourozeneckém bloku. Staré skiny
  // (např. BMW-Syndikat) dávají autora/datum do `div.headline_big_show` TĚSNĚ
  // PŘED tělo `div.forum_show_outer` — autor tedy není uvnitř těla. Když je
  // `header_selector` zadán, autora/datum hledáme v nejbližší PŘEDCHÁZEJÍCÍ
  // hlavičce (podle pozice ve zdroji), ne v těle. Bez něj beze změny.
  const headers = calibration.header_selector
    ? selectElements(html, calibration.header_selector)
    : null;
  const headerScopeFor = (container) => {
    if (!headers || headers.length === 0) return null;
    let best = null;
    for (const h of headers) {
      if (h.outerStart < container.outerStart && (!best || h.outerStart > best.outerStart)) best = h;
    }
    return best ? best.innerHtml : null;
  };

  const posts = [];
  for (const container of containers) {
    let contentHtml = container.innerHtml;
    if (calibration.content_selector) {
      const found = selectElements(contentHtml, calibration.content_selector);
      if (found.length > 0) contentHtml = found.map(f => f.innerHtml).join('\n');
    }
    if (calibration.quote_selector) {
      contentHtml = removeElementsBySelector(contentHtml, calibration.quote_selector);
    }

    const text = cleanPostText(htmlToText(contentHtml), minLength);
    if (!text) continue;

    // Autor/datum: z hlavičkového sourozence (header_selector), jinak z těla.
    const authorScope = headers ? (headerScopeFor(container) ?? '') : container.innerHtml;
    const author = calibration.author_selector
      ? firstElementText(authorScope, calibration.author_selector)
      : '';
    const when = calibration.date_selector
      ? firstElementDate(authorScope, calibration.date_selector)
      : '';

    posts.push({
      author: author || '',
      postId: extractPostId(container.attrText),
      when: when || '',
      pageNumber,
      text,
    });
  }

  return posts;
}

// ---------------------------------------------------------------------------
// Extract thread links from a section/index page
// ---------------------------------------------------------------------------

export function extractThreadLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=(?:"|')([^"']+)(?:"|')[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1];
    // Decode HTML entities in href (e.g. &amp; → &, &#38; → &)
    href = decodeHtmlAttribute(href);

    const text = htmlToText(m[2]).trim();
    if (!href || !text || text.length < 5) continue;

    // Resolve relative URLs
    try {
      href = new URL(href, baseUrl).href;
    } catch {
      continue;
    }

    // Strip fragment from URL, skip pure anchors
    try {
      const parsed = new URL(href);
      parsed.hash = '';
      href = parsed.href;
    } catch { /* keep as-is */ }

    // Skip non-thread links
    if (href.includes('/login') || href.includes('/register')) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    links.push({ url: href, title: text });
  }

  return links;
}

// ---------------------------------------------------------------------------
// Pagination — find "next page" link
// ---------------------------------------------------------------------------

// Resolve a pagination href and strip the fragment — some WAFs (observed on
// toyotanation.com) reject otherwise-valid pagination URLs carrying #replies
// or #post-N fragments, and fragments never change the fetched content.
function resolvePageLink(href, baseUrl) {
  try {
    const url = new URL(href, baseUrl);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function findNextPageLink(html, baseUrl, paginationSelector) {
  const selectors = (paginationSelector ?? '')
    .toString()
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .flatMap(selector => [selector, `${selector} a`]);

  if (selectors.length > 0) {
    for (const anchor of collectAnchorsWithAncestors(html)) {
      if (!selectors.some(selector => selectorMatchesAnchor(selector, anchor.attrText, anchor.ancestorStack))) continue;
      const attrMap = parseTagAttrs(anchor.attrText);
      const href = decodeHtmlAttribute(attrMap.get('href') ?? '');
      if (!href) continue;
      const resolved = resolvePageLink(href, baseUrl);
      if (resolved) return resolved;
    }
  }

  // Try common patterns for "next" links
  const patterns = [
    /<a\b[^>]*class=(?:"|')[^"']*\bnext\b[^"']*(?:"|')[^>]*href=(?:"|')([^"']+)(?:"|')/i,
    /<a\b[^>]*href=(?:"|')([^"']+)(?:"|')[^>]*class=(?:"|')[^"']*\bnext\b[^"']*(?:"|')/i,
    /<a\b[^>]*rel=(?:"|')next(?:"|')[^>]*href=(?:"|')([^"']+)(?:"|')/i,
    /<a\b[^>]*href=(?:"|')([^"']+)(?:"|')[^>]*rel=(?:"|')next(?:"|')/i,
    /<li\b[^>]*class=(?:"|')[^"']*\bnext\b[^"']*(?:"|')[^>]*>\s*<a\b[^>]*href=(?:"|')([^"']+)(?:"|')/i,
    // <link rel="next"> in the document head. WoltLab (RenaultForum.net,
    // PeugeotTalk.de, MeinID) publishes listing/thread pagination ONLY here —
    // its body next-button carries no matchable class/rel, so sections were
    // marked "done" after page 1 (false "archive complete", review 2026-07-02).
    /<link\b[^>]*rel=(?:"|')next(?:"|')[^>]*href=(?:"|')([^"']+)(?:"|')/i,
    /<link\b[^>]*href=(?:"|')([^"']+)(?:"|')[^>]*rel=(?:"|')next(?:"|')/i,
    // SMF (PeugeotClub Slovakia): the next-page link is the navPages anchor
    // whose text is the » glyph. Numbered navPages anchors must NOT match —
    // only the explicit »/&raquo; one.
    /<a\b[^>]*class=(?:"|')[^"']*\bnavPages\b[^"']*(?:"|')[^>]*href=(?:"|')([^"']+)(?:"|')[^>]*>\s*(?:»|&raquo;|&#187;)/i,
    // Weakest heuristic LAST: a next button marked only by its text label
    // (kia-club.org phpBB skin: <a href="...&start=25" class="right-box">Další).
    // The href must look like pagination (start=/offset=/page…) so ordinary
    // "next topic"-style links can never match.
    /<a\b[^>]*href=(?:"|')([^"']*(?:[?&;](?:start|offset)=\d|[?&;]page(?:no)?=\d|\/page\d|page\d+\.html)[^"']*)(?:"|')[^>]*>(?:\s|&nbsp;|<span[^>]*>|<i[^>]*>|<b[^>]*>)*(?:Další|Ďalej|Ďalšia|Weiter|Nächste|Next|Suivant|›|»|&raquo;|&#187;|&rsaquo;)/i,
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) {
      const resolved = resolvePageLink(decodeHtmlAttribute(m[1]), baseUrl);
      if (resolved) return resolved;
    }
  }

  return null;
}
