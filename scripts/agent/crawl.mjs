/**
 * crawl.mjs — Fetch + parse module for the autonomous crawl agent.
 *
 * Handles HTTP fetching with rate limiting, parser dispatch based on
 * forum type detection or calibration config, and thread URL enumeration.
 *
 * Usage:
 *   import { createCrawlPipeline } from './crawl.mjs';
 */

import { detectForumType } from './parsers/detect.mjs';
import { parseInvision } from './parsers/invision.mjs';
import { parseXenforo } from './parsers/xenforo.mjs';
import { parsePhpbb } from './parsers/phpbb.mjs';
import { parseGeneric } from './parsers/generic.mjs';
import { parseWoltlab } from './parsers/woltlab.mjs';
import {
  htmlToText,
  extractTitle,
  buildThreadText,
  extractThreadLinks,
  extractThreadLinksBySelector,
  findNextPageLink,
  selectPosts,
  threadLastActivity,
} from './parsers/common.mjs';
import { classifyThread } from './classify.mjs';
import { extractCases } from './extract.mjs';
import { validateCase } from './validate.mjs';
import { dedupeThreadCases } from './dedup-thread-cases.mjs';
import { isStoppingError } from './quota.mjs';
import { fetchHtml } from './fetch-utils.mjs';
import { canonicalizeThreadUrl, canonicalizeTraversalUrl } from './url-utils.mjs';
import { pickCalibrationSample } from './resolution-signal.mjs';

// ---------------------------------------------------------------------------
// Parser dispatch
// ---------------------------------------------------------------------------

const PARSERS = {
  invision: parseInvision,
  xenforo: parseXenforo,
  phpbb: parsePhpbb,
  woltlab: parseWoltlab,
  vbulletin: parseGeneric, // vBulletin uses generic with calibration-driven selectors
  generic: parseGeneric,
};

function parseHtml(html, parserKey, calibration, pageNumber) {
  // Honor LLM-calibrated CSS selectors first — they work across every forum
  // engine (incl. JS platforms like VerticalScope "Fora" that the regex
  // engine parsers miss). Fall back to the engine parser only if selectors
  // are absent or yield too little.
  if (calibration?.post_selector) {
    const selected = selectPosts(html, calibration, pageNumber);
    if (selected.length >= 2) return { posts: selected };
  }
  const parser = PARSERS[parserKey] || PARSERS.generic;
  return parser(html, calibration, pageNumber);
}

// Thread-age policy: a thread is mined only once its newest post is at least this
// old (default 1 year). Override with AGENT_MIN_THREAD_AGE_DAYS for testing/tuning.
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
export function minThreadAgeMs() {
  const days = Number(process.env.AGENT_MIN_THREAD_AGE_DAYS);
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : ONE_YEAR_MS;
}

export function isLikelyThreadUrl(url) {
  const value = (url ?? '').toString();
  return (
    /\/topic\/|(?:\/|\?)thread\/|viewtopic|showthread|\/threads\/|(?:\/|\?)t\d|\/discussion\//i.test(value) &&
    !/\/blogs?\/|\/tests?\/|\/news\/|\/articles?\/|\/reviews?\//i.test(value)
  );
}

/**
 * Filtr URL vláken pro enumeraci. Když profil/kalibrace zadá `thread_url_pattern`
 * (regex), je autoritativní — generická heuristika isLikelyThreadUrl totiž
 * nepozná netypické tvary (např. BMW-Syndikat `/topic408759_…​.html` bez lomítka
 * za „topic"). Nevalidní regex → fallback na heuristiku.
 */
export function makeThreadUrlFilter(calibration) {
  const raw = calibration?.thread_url_pattern;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const re = new RegExp(raw, 'i');
      // URL pochází z cizí stránky (externí vstup) — strop délky brání ReDoS
      // u pathologického vzoru × extrémně dlouhé URL. Reálné URL vláken jsou
      // krátké; >2000 znaků = beztak ne-thread.
      return (url) => {
        const s = (url ?? '').toString();
        return s.length <= 2000 && re.test(s);
      };
    } catch {
      // nevalidní regex v profilu → fallback níže
    }
  }
  return isLikelyThreadUrl;
}

// ---------------------------------------------------------------------------
// Multi-page thread fetching
// ---------------------------------------------------------------------------

async function fetchThreadPages(url, parserKey, calibration, sleepMs) {
  const allPosts = [];
  let currentUrl = url;
  let pageNumber = 1;
  let firstPageHtml = '';
  let resolvedParser = parserKey;
  const maxPages = 10;

  while (currentUrl && pageNumber <= maxPages) {
    let html = await fetchHtml(currentUrl, { cookie: calibration.cookie, forceBrowser: calibration.force_browser });
    if (pageNumber === 1) {
      // Auto-detect forum type on first page if parser is unknown/generic
      if (!resolvedParser || resolvedParser === 'generic' || resolvedParser === 'unknown') {
        const detected = detectForumType(html);
        if (detected !== 'generic') {
          resolvedParser = detected;
        }
      }

      // JS-rendered shell: HTTP 200 but no parseable posts. Re-fetch page 1 via
      // a headless browser render once so SPA forums aren't silently discarded.
      let posts = parseHtml(html, resolvedParser, calibration, pageNumber).posts;
      if (posts.length === 0) {
        const rendered = await fetchHtml(currentUrl, { cookie: calibration.cookie, forceBrowser: true })
          .catch(() => null);
        if (rendered) {
          html = rendered;
          if (!resolvedParser || resolvedParser === 'generic' || resolvedParser === 'unknown') {
            const detected = detectForumType(html);
            if (detected !== 'generic') resolvedParser = detected;
          }
          posts = parseHtml(html, resolvedParser, calibration, pageNumber).posts;
        }
      }
      firstPageHtml = html;
      allPosts.push(...posts);
    } else {
      const { posts } = parseHtml(html, resolvedParser, calibration, pageNumber);
      allPosts.push(...posts);
    }

    // Look for next page
    const nextUrl = findNextPageLink(html, currentUrl, calibration.pagination_selector);
    if (nextUrl && nextUrl !== currentUrl) {
      currentUrl = nextUrl;
      pageNumber++;
      if (sleepMs) await new Promise(r => setTimeout(r, sleepMs));
    } else {
      break;
    }
  }

  return { posts: allPosts, html: firstPageHtml, pageCount: pageNumber };
}

// ---------------------------------------------------------------------------
// Thread URL enumeration from forum sections
// ---------------------------------------------------------------------------

export async function enumerateThreadUrls(forum, calibration, maxThreads, sleepMs, options = {}) {
  const sections = safeJsonParse(forum.sections_json, []);
  const urls = [];
  const seen = new Set();
  const fetcher = options.fetchHtmlImpl ?? fetchHtml;
  const threadUrlFilter = makeThreadUrlFilter(calibration);
  const maxSectionPages = options.maxSectionPages ?? (Number(calibration.max_section_pages) || 10);
  const forumRootUrl = canonicalizeTraversalUrl(forum.url);

  // If no sections configured, try the forum URL itself as a section
  const sectionUrls = sections.length > 0
    ? sections.map(s => typeof s === 'string' ? s : s.url).filter(Boolean)
    : [forum.url];

  async function enumerateSection(rootSectionUrl, pageLimit = maxSectionPages) {
    if (urls.length >= maxThreads) return { hadError: false };

    let sectionUrl = canonicalizeTraversalUrl(rootSectionUrl);
    const seenSectionPages = new Set();
    let sectionPageCount = 0;
    let hadError = false;

    while (sectionUrl && urls.length < maxThreads && sectionPageCount < pageLimit) {
      if (seenSectionPages.has(sectionUrl)) break;
      seenSectionPages.add(sectionUrl);
      sectionPageCount++;

      try {
        const html = await fetcher(sectionUrl, { cookie: calibration.cookie, forceBrowser: calibration.force_browser });

        let links = [];
        if (calibration.thread_list_selector) {
          links = extractThreadLinksBySelector(html, sectionUrl, calibration.thread_list_selector);
        }
        if (links.length === 0) {
          links = extractThreadLinks(html, sectionUrl);
        }

        const threadLinks = links
          .map(link => ({
            ...link,
            url: canonicalizeThreadUrl(link.url),
          }))
          .filter(link => threadUrlFilter(link.url));

        for (const link of threadLinks) {
          if (urls.length >= maxThreads) break;
          if (seen.has(link.url)) continue;
          seen.add(link.url);
          urls.push(link);
        }

        const nextSectionUrl = findNextPageLink(
          html,
          sectionUrl,
          calibration.section_pagination_selector || calibration.pagination_selector
        );
        sectionUrl = nextSectionUrl ? canonicalizeTraversalUrl(nextSectionUrl) : null;
      } catch (err) {
        console.error(`  Error enumerating ${sectionUrl}: ${err.message}`);
        hadError = true;
        break;
      }

      if (sleepMs && sectionUrl) await new Promise(r => setTimeout(r, sleepMs));
    }

    return { hadError };
  }

  // Try EVERY configured section before any fallback. A single blocked
  // section (e.g. one listing behind an anti-bot 406) must not abandon the
  // remaining technical sections in favor of the noisy forum homepage.
  for (const rootSectionUrl of sectionUrls) {
    await enumerateSection(rootSectionUrl);
    if (urls.length >= maxThreads) break;
  }

  // Only when all sections together yielded nothing, fall back to the forum
  // root (homepage carousels still list recent threads on many platforms).
  if (
    urls.length === 0 &&
    sections.length > 0 &&
    forumRootUrl &&
    !sectionUrls.some(url => canonicalizeTraversalUrl(url) === forumRootUrl)
  ) {
    console.warn(`  Section enumeration yielded no threads for ${forum.url}; falling back to forum root.`);
    await enumerateSection(forum.url, 1);
  }

  return urls;
}

// ---------------------------------------------------------------------------
// Deep archive enumeration (persistent per-section cursor)
// ---------------------------------------------------------------------------

/**
 * Walk a forum's listing pages IN ORDER, deep into the archive, remembering a
 * per-section cursor so successive batches march further back (page 2 → 3 →
 * … → last) instead of re-reading the newest threads.
 *
 * This is the archive miner — the owner's primary goal. The legacy
 * `enumerateThreadUrls` only ever sampled the first ~60 (newest) threads of
 * each section and never advanced, so a forum's archive of thousands of older
 * threads was never reached and the forum was wrongly parked as "exhausted".
 *
 * Coverage is gap-free: a batch only ever advances by WHOLE listing pages and
 * collects every thread link on them, so the cursor always sits on a page
 * boundary. Brand-new threads (which appear on page 1) are the "cherry on top"
 * and are picked up by a shallow head-scan once the archive is complete.
 *
 * @param {object} forum                    forum row (uses sections_json / url)
 * @param {object} calibration              parsed calibration_json
 * @param {object} [opts]
 * @param {object} [opts.cursor]            prior cursor:
 *   { sections: { <sectionUrl>: { next, done, pages } }, complete }
 * @param {number} [opts.pagesPerBatch=2]   listing pages to advance per call
 * @param {boolean} [opts.headScan=false]   ignore cursor; re-scan section heads
 *   for genuinely-new threads (does NOT advance/persist the deep cursor)
 * @param {number} [opts.sleepMs=0]
 * @param {function} [opts.fetchHtmlImpl]   injectable fetcher (tests)
 * @returns {Promise<{ links: Array, cursor: object, complete: boolean }>}
 */
export async function enumerateThreadUrlsDeep(forum, calibration = {}, opts = {}) {
  const fetcher = opts.fetchHtmlImpl ?? fetchHtml;
  const sleepMs = opts.sleepMs ?? 0;
  const pagesPerBatch = Math.max(1, opts.pagesPerBatch ?? 2);
  const headScan = !!opts.headScan;
  const threadUrlFilter = makeThreadUrlFilter(calibration);

  const sections = safeJsonParse(forum.sections_json, []);
  const sectionUrls = (sections.length > 0
    ? sections.map(s => (typeof s === 'string' ? s : s.url)).filter(Boolean)
    : [forum.url])
    .map(u => canonicalizeTraversalUrl(u))
    .filter(Boolean);

  // Carry forward prior per-section progress; never mutate the caller's object.
  const cursor = { sections: { ...(opts.cursor?.sections || {}) }, complete: false };

  const links = [];
  const seen = new Set();

  for (const sectionKey of sectionUrls) {
    const prior = cursor.sections[sectionKey] || { next: null, done: false, pages: 0 };
    // In deep mode a finished section is skipped; head-scan always re-reads heads.
    if (!headScan && prior.done) {
      cursor.sections[sectionKey] = prior;
      continue;
    }

    // Deep mode resumes from the stored next page; head-scan / first visit
    // starts at the section root.
    const startUrl = headScan
      ? sectionKey
      : (prior.next ? canonicalizeTraversalUrl(prior.next) : sectionKey);

    const entry = headScan
      ? { next: prior.next ?? null, done: prior.done ?? false, pages: prior.pages ?? 0 }
      : prior;

    let pageUrl = startUrl;
    let pagesThisBatch = 0;
    const seenPages = new Set();

    while (pageUrl && pagesThisBatch < pagesPerBatch) {
      if (seenPages.has(pageUrl)) {
        if (!headScan) { entry.done = true; entry.next = null; }
        break;
      }
      seenPages.add(pageUrl);

      let html;
      try {
        html = await fetcher(pageUrl, { cookie: calibration.cookie, forceBrowser: calibration.force_browser });
      } catch (err) {
        // Transient (anti-bot/timeout): leave the cursor where it is so the
        // next batch retries this exact page — never skip archive pages.
        console.error(`  Error enumerating ${pageUrl}: ${err.message}`);
        break;
      }

      let pageLinks = [];
      if (calibration.thread_list_selector) {
        pageLinks = extractThreadLinksBySelector(html, pageUrl, calibration.thread_list_selector);
      }
      if (pageLinks.length === 0) {
        pageLinks = extractThreadLinks(html, pageUrl);
      }
      for (const link of pageLinks) {
        const url = canonicalizeThreadUrl(link.url);
        if (!threadUrlFilter(url) || seen.has(url)) continue;
        seen.add(url);
        links.push({ ...link, url });
      }

      pagesThisBatch++;
      entry.pages = (entry.pages || 0) + 1;

      const nextUrl = findNextPageLink(
        html,
        pageUrl,
        calibration.section_pagination_selector || calibration.pagination_selector,
        { numbered: calibration.pagination_mode === 'numbered', numberRe: calibration.pagination_number_re }
      );
      const canonicalNext = nextUrl ? canonicalizeTraversalUrl(nextUrl) : null;
      if (!canonicalNext || canonicalNext === pageUrl) {
        // Last listing page of this section reached → archive end.
        if (!headScan) { entry.done = true; entry.next = null; }
        pageUrl = null;
      } else {
        if (!headScan) entry.next = canonicalNext;
        pageUrl = canonicalNext;
      }

      if (sleepMs && pageUrl) await new Promise(r => setTimeout(r, sleepMs));
    }

    if (!headScan) cursor.sections[sectionKey] = entry;
  }

  // Complete only once EVERY section has been walked to its last page.
  cursor.complete = !headScan
    && sectionUrls.length > 0
    && sectionUrls.every(k => cursor.sections[k]?.done);

  return { links, cursor, complete: cursor.complete };
}

// ---------------------------------------------------------------------------
// Pipeline factory — used by orchestrator and calibration
// ---------------------------------------------------------------------------

/**
 * Create a complete crawl pipeline with all stages wired.
 *
 * @param {object} opts
 * @param {number} [opts.sleepMs=600] - Delay between HTTP requests
 * @param {string} [opts.apiKey] - DeepSeek API key (only used for tasks
 *   routed to DeepSeek — see llm.mjs)
 * @returns {object} Pipeline functions for orchestrator/calibration
 */
export function createCrawlPipeline(opts = {}) {
  const sleepMs = opts.sleepMs ?? 600;
  const apiKey = opts.apiKey || process.env.DEEPSEEK_API_KEY;

  return {
    /**
     * Sample thread URLs from a forum for the production crawl.
     *
     * Intentionally RANDOM: the sampled set feeds the exhaustion/cooldown math
     * (computeCooldown in orchestrator.mjs). A deterministic bias here would
     * re-pick the same threads every batch and trip a premature "exhausted"
     * cooldown. Calibration uses sampleThreadUrlsForCalibration() instead.
     */
    async sampleThreadUrls(forum, count) {
      const calibration = safeJsonParse(forum.calibration_json);
      const allUrls = await enumerateThreadUrls(forum, calibration, count * 3, sleepMs);
      // Shuffle and take `count`
      const shuffled = allUrls.sort(() => Math.random() - 0.5);
      return shuffled.slice(0, count).map(l => l.url);
    },

    /**
     * Sample thread URLs for the CALIBRATION probe, biased toward likely-resolved
     * threads. Calibration must measure the forum's true potential; sampling the
     * newest (unanswered) threads makes good forums fail. Enumerates a wider,
     * deeper window than the production sampler so scoring can reach older
     * (likelier-resolved) threads, then prioritises resolution-signal titles.
     * This is calibration-only and never touches the cooldown math.
     */
    async sampleThreadUrlsForCalibration(forum, count) {
      const calibration = safeJsonParse(forum.calibration_json);
      const allUrls = await enumerateThreadUrls(forum, calibration, count * 6, sleepMs);
      const language = calibration.language || forum.language || '';
      return pickCalibrationSample(allUrls, count, language).map(l => l.url);
    },

    /**
     * Fetch a thread URL and parse it into structured data.
     */
    async fetchAndParse(url, calibration = {}) {
      const parserKey = calibration.parser || 'generic';
      const { posts, html, pageCount } = await fetchThreadPages(url, parserKey, calibration, sleepMs);
      const title = extractTitle(html);
      const threadText = buildThreadText({ url, title, posts });

      return {
        posts,
        // Keep 30K of body HTML for diagnosis — skip <head> (GDPR scripts)
        html: (() => { const b = html.indexOf('<body'); return (b !== -1 ? html.slice(b) : html).slice(0, 30_000); })(),
        threadText,
        title,
        pageCount,
      };
    },

    /**
     * Classify a thread — L2 routed-LLM classifier.
     */
    async classify(threadText) {
      if (sleepMs) await new Promise(r => setTimeout(r, sleepMs));
      return classifyThread(threadText, { apiKey });
    },

    /**
     * Extract cases from a classified thread — L3 routed-LLM extractor.
     */
    async extract(threadText, classifierResult) {
      if (sleepMs) await new Promise(r => setTimeout(r, sleepMs));
      return extractCases(threadText, classifierResult, { apiKey });
    },

    /**
     * Validate extracted case — L4 deterministic gates.
     */
    validate(caseData, threadText) {
      return validateCase(caseData, { threadText });
    },

    /**
     * Collapse same-thread duplicate cases (same fault + same repair) — keeps the
     * richest, drops the rest. Quota/auth errors propagate (stop the run); any
     * other failure fails OPEN (returns the cases unchanged) so a transient judge
     * hiccup can never silently drop a case.
     */
    async dedupeCases(entries) {
      if (sleepMs) await new Promise(r => setTimeout(r, sleepMs));
      try {
        const { entries: kept, merged } = await dedupeThreadCases(entries);
        if (merged > 0) console.log(`  Merged ${merged} same-thread duplicate case(s).`);
        return kept;
      } catch (err) {
        if (isStoppingError(err)) throw err;
        console.error(`  Dedup judge failed (keeping all cases): ${err.message}`);
        return entries;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Full thread processing — fetch → parse → classify → extract → validate
// ---------------------------------------------------------------------------

/**
 * Process a single thread URL through the full pipeline.
 *
 * @param {string} url
 * @param {object} calibration
 * @param {object} pipeline - From createCrawlPipeline()
 * @param {object} [opts]              test/tuning hooks
 * @param {number} [opts.now]          epoch ms treated as "now" (default Date.now())
 * @param {number} [opts.minThreadAgeMs] age threshold (default minThreadAgeMs())
 * @returns {Promise<{ threadText, title, cases: Array<{case, validation}>, skipped: string|null,
 *   deferred?: boolean, lastPostAt?: string, revisitAfter?: string }>}
 *   When `deferred` is true the thread is too young to judge yet: the caller should
 *   set it aside (status 'deferred') with `revisitAfter` instead of discarding it.
 */
export async function processThread(url, calibration, pipeline, opts = {}) {
  // Fetch & parse
  const parseResult = await pipeline.fetchAndParse(url, calibration);
  if (!parseResult.posts || parseResult.posts.length < 2) {
    return { threadText: '', title: '', cases: [], skipped: 'Too few posts' };
  }

  // ── Thread-age gate ──
  // Mine a thread only once its newest post is at least ~1 year old. A fresh
  // thread may not carry its fix yet, and once we discard a thread we never look
  // again — so judging it too early permanently loses a resolution that lands
  // later. Too young => DEFER (revisit after it matures) rather than discard.
  // Unknown age (no parseable date, e.g. localized listings) => process now: the
  // safe direction is never to silently drop a thread we cannot date.
  const now = opts.now ?? Date.now();
  const minAge = opts.minThreadAgeMs ?? minThreadAgeMs();
  const lastActivityMs = threadLastActivity(parseResult.posts);
  // `lastActivityMs <= now` guards a future-dated post (clock skew, wrong-TZ
  // <time>, typo year): treat "in the future" as mature now and process it,
  // never park a ready thread for years.
  if (lastActivityMs != null && lastActivityMs <= now && (now - lastActivityMs) < minAge) {
    return {
      threadText: parseResult.threadText,
      title: parseResult.title,
      cases: [],
      skipped: null,
      deferred: true,
      lastPostAt: new Date(lastActivityMs).toISOString(),
      revisitAfter: new Date(lastActivityMs + minAge).toISOString(),
    };
  }

  // Classify
  const classification = await pipeline.classify(parseResult.threadText);
  if (!classification.approved) {
    return {
      threadText: parseResult.threadText,
      title: parseResult.title,
      cases: [],
      skipped: `Classifier rejected: ${classification.reason}`,
    };
  }

  // Extract
  const rawCases = await pipeline.extract(parseResult.threadText, classification);
  if (!rawCases || rawCases.length === 0) {
    return {
      threadText: parseResult.threadText,
      title: parseResult.title,
      cases: [],
      skipped: 'Extractor returned no cases',
    };
  }

  // Validate each case
  let cases = rawCases.map(c => ({
    case: c,
    validation: pipeline.validate(c, parseResult.threadText),
  }));

  // Collapse same-thread duplicates (several members reporting the same fault +
  // same repair → one case). Optional pipeline step so mock pipelines (tests,
  // calibration) that omit it keep the previous behaviour.
  if (pipeline.dedupeCases) {
    cases = await pipeline.dedupeCases(cases);
  }

  return {
    threadText: parseResult.threadText,
    title: parseResult.title,
    cases,
    skipped: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJsonParse(str, fallback = {}) {
  try {
    return JSON.parse(str || JSON.stringify(fallback)) || fallback;
  } catch {
    return fallback;
  }
}
