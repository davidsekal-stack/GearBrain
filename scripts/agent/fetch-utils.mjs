import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnManaged, terminateProcessTree } from './process-utils.mjs';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,cs;q=0.8,de;q=0.7',
};

const BROWSER_BLOCK_STATUSES = new Set([403, 406]);
const BROWSER_FETCH_PATTERNS = [
  /cf-browser-verification/i,
  /checking your browser/i,
  /verify you are human/i,
  /attention required/i,
  /just a moment/i,
  /enable javascript and cookies/i,
  // VerticalScope proof-of-work interstitial (e.g. VWVortex): served at HTTP 200
  // as a ~1.8KB JS shell. Its headless_check refuses the cookie when
  // navigator.webdriver is true, so the system-Chrome --dump-dom can't solve it;
  // matching here lets the plain path escalate to the fingerprinted Crawlee
  // browser, which sets navigator.webdriver=false and clears the challenge.
  /POW_CHALLENGE_DATA/i,
  /challenge_nonce/i,
  // Apache "soft 403" block page (observed on germancarforum.com — VerticalScope
  // edge WAF): a 248-byte "403 Forbidden / You don't have permission to access
  // this resource" document. Both plain fetch AND the system-Chrome --dump-dom
  // receive this same block page, and because it is valid HTML that matches no
  // challenge/error pattern it was being accepted as "usable", which (a) poisons
  // the crawl with the block page and (b) short-circuits escalation to Crawlee.
  // The fingerprinted Crawlee browser clears this WAF and returns real HTML, so
  // flag the block page as a challenge to force the fallback chain through to it.
  /<title>403 Forbidden<\/title>[\s\S]*don't have permission to access this resource/i,
];
const BROWSER_ERROR_PATTERNS = [
  /main-frame-error/i,
  /this site can['’]t be reached/i,
  /tato str[aá]nka nen[ií] dostupn[aá]/i,
  /err_[a-z_]+/i,
];
const BROWSER_EXECUTABLE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

// Cached only after a candidate produces a real DOM dump — some installs
// (observed: Edge on this machine) exit 0 with EMPTY --dump-dom output, so
// "the executable exists" is not enough to commit to it.
let workingBrowserExecutable;
// Session blacklist for executables that exit without producing any DOM.
const brokenBrowserExecutables = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isHtmlDocument(value) {
  const text = (value ?? '').toString();
  return /<!doctype html|<html\b/i.test(text);
}

export function isLikelyChallengeHtml(value) {
  const text = (value ?? '').toString();
  return BROWSER_FETCH_PATTERNS.some(pattern => pattern.test(text));
}

export function isLikelyBrowserErrorHtml(value) {
  const text = (value ?? '').toString();
  return BROWSER_ERROR_PATTERNS.some(pattern => pattern.test(text));
}

// A fetched response is usable HTML only if it's a 2xx real HTML document that
// is neither a WAF challenge nor a browser error page. Used by the got-scraping
// tier to judge its own response. (The plain-fetch path keeps its existing
// inline checks; this is not wired into it.)
export function shouldAcceptFetchedHtml(statusCode, html) {
  if (typeof statusCode === 'number' && (statusCode < 200 || statusCode >= 300)) return false;
  if (!isHtmlDocument(html)) return false;
  if (isLikelyChallengeHtml(html) || isLikelyBrowserErrorHtml(html)) return false;
  return true;
}

function resolveOrigin(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/`;
  } catch {
    return null;
  }
}

export function listBrowserExecutables() {
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [...BROWSER_EXECUTABLE_CANDIDATES];
  if (localAppData) {
    candidates.unshift(join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return candidates.filter(path => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  });
}

function dumpDomWithBrowser(executable, url, userDataDir, timeoutMs) {
  return new Promise((resolve, reject) => {
    const virtualTimeBudget = Math.max(4_000, Math.min(timeoutMs - 2_000, 12_000));
    const args = [
      `--user-data-dir=${userDataDir}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
      '--disable-sync',
      `--virtual-time-budget=${virtualTimeBudget}`,
      '--dump-dom',
      url,
    ];
    const child = spawnManaged(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', err => {
      clearTimeout(timer);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        const err = new Error(`Browser fallback timed out after ${timeoutMs}ms`);
        err.code = 'ETIMEDOUT';
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function tryBrowserFallback(url, options = {}) {
  try {
    return {
      html: await fetchHtmlWithBrowser(url, options),
      error: null,
    };
  } catch (err) {
    return { html: null, error: err };
  }
}

// Strongest fallback: Crawlee's fingerprinted (and optionally residential-proxied)
// browser, for WAFs that block both plain fetch AND the system-Chrome DOM dump
// (e.g. VerticalScope's 403/406). Lazy-imported so the normal crawl path stays
// dependency-free; if crawlee/playwright isn't installed, this degrades to a
// no-op. Disable with AGENT_DISABLE_CRAWLEE=1.
async function tryCrawleeFallback(url, options = {}) {
  if (process.env.AGENT_DISABLE_CRAWLEE === '1') {
    return { html: null, error: new Error('Crawlee fallback disabled') };
  }
  try {
    const { fetchHtmlWithCrawlee } = await import('./crawlee-fetch.mjs');
    const html = await fetchHtmlWithCrawlee(url, options);
    return { html: html || null, error: html ? null : new Error('Crawlee returned no HTML') };
  } catch (err) {
    return { html: null, error: err };
  }
}

// Fingerprinted HTTP fetch (got-scraping): mimics a real browser's TLS/JA3 and
// header ordering WITHOUT launching a browser. Many WAFs (VerticalScope's
// 403/406, some Cloudflare edges) block on TLS/header fingerprint rather than
// IP reputation, and fall for this — letting us skip the far slower
// system-Chrome and Crawlee tiers. got-scraping ships transitively with
// crawlee, so this adds no dependency. Lazy-imported to keep the happy path
// light. OPT-IN (default off) so it never changes the unattended nightly run
// without a deliberate switch — enable with AGENT_ENABLE_GOTSCRAPING=1.
// NOTE: this does NOT defeat IP-based blocks (verified 2026-07-13: dieselpower.cz
// and forum.mazdaklub.eu still 403 here — those need a real clean IP, if anything).
let gotScrapingImpl; // undefined = not tried, null = unavailable
async function loadGotScraping() {
  if (gotScrapingImpl === undefined) {
    try {
      ({ gotScraping: gotScrapingImpl } = await import('got-scraping'));
      gotScrapingImpl = gotScrapingImpl ?? null;
    } catch {
      gotScrapingImpl = null;
    }
  }
  return gotScrapingImpl;
}

async function tryGotScrapingFallback(url, options = {}) {
  if (process.env.AGENT_ENABLE_GOTSCRAPING !== '1') {
    return { html: null, error: new Error('got-scraping fallback not enabled') };
  }
  try {
    const gotScraping = await loadGotScraping();
    if (!gotScraping) return { html: null, error: new Error('got-scraping unavailable') };
    const headers = {};
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.referer) headers.Referer = options.referer;
    const res = await gotScraping({
      url,
      timeout: { request: options.timeoutMs ?? 30_000 },
      retry: { limit: 0 },
      throwHttpErrors: false,
      followRedirect: true,
      headers,
      // Let got-scraping synthesize a realistic desktop-Chrome fingerprint
      // (TLS + header order + sec-ch-ua) rather than our static UA string.
      headerGeneratorOptions: {
        browsers: [{ name: 'chrome', minVersion: 120 }],
        operatingSystems: ['windows'],
        devices: ['desktop'],
      },
    });
    const body = typeof res.body === 'string' ? res.body : '';
    if (!shouldAcceptFetchedHtml(res.statusCode, body)) {
      return { html: null, error: new Error(`got-scraping received HTTP ${res.statusCode}`) };
    }
    return { html: body, error: null };
  } catch (err) {
    return { html: null, error: err };
  }
}

// Ordered anti-bot escalation, cheapest first: fingerprinted HTTP (got-scraping)
// → system-Chrome DOM dump → Crawlee/Playwright. Returns the first usable HTML,
// or { html: null, crawleeError } if every tier failed (crawleeError carries the
// last tier's detail for the caller's message). Callers decide what to throw, so
// the three block branches share ONE ordering instead of three copies.
async function escalateBlockedFetch(url, options = {}) {
  const { html: gotHtml } = await tryGotScrapingFallback(url, options);
  if (gotHtml) return { html: gotHtml, crawleeError: null };
  const { html: browserHtml } = await tryBrowserFallback(url, options);
  if (browserHtml) return { html: browserHtml, crawleeError: null };
  const { html: crawleeHtml, error: crawleeError } = await tryCrawleeFallback(url, options);
  return { html: crawleeHtml || null, crawleeError: crawleeHtml ? null : crawleeError };
}

// ── robots.txt politeness ──────────────────────────────────────────────────
// OFF by default: the nightly crawl behaves exactly as before unless opted in.
//   AGENT_ROBOTS_MODE=log      → fetch robots.txt, LOG disallowed URLs, still crawl
//   AGENT_ROBOTS_MODE=enforce  → throw on URLs that robots.txt disallows
// Many forums disallow bots broadly, so 'enforce' can sharply cut coverage —
// run 'log' first to measure the impact before turning on enforcement.
// CAVEAT: 'enforce' throws a plain fetch error; callers (orchestrator/calibrate)
// do NOT yet distinguish a robots skip from a real fetch failure, so a disallowed
// thread lands as status 'error' and a fully-disallowed forum can trip the
// failure circuit breaker. 'log' is the recommended/production-safe mode until
// caller-side skip handling is wired up.
export function resolveRobotsMode(env = process.env) {
  const raw = (env.AGENT_ROBOTS_MODE ?? '').trim().toLowerCase();
  if (raw === 'log' || raw === 'advisory') return 'log';
  if (raw === 'enforce' || raw === '1' || raw === 'true') return 'enforce';
  return 'off';
}

// origin -> Promise<RobotsTxtFile | null>. Caching the PROMISE (not the resolved
// value) dedupes concurrent first-hits to the same origin into ONE robots.txt
// fetch. A resolved null means the load failed and is treated as allow-all.
const robotsCache = new Map();

export function __resetRobotsCacheForTests() {
  robotsCache.clear();
}

function loadRobotsForOrigin(origin) {
  if (!robotsCache.has(origin)) {
    const loading = (async () => {
      try {
        const { RobotsTxtFile } = await import('crawlee');
        // Bound the lookup (crawlee otherwise inherits got-scraping's 60s
        // default, stalling the crawl on a slow /robots.txt), and use the same
        // proxy as the Crawlee tier so the decision matches our crawl identity.
        return await RobotsTxtFile.find(origin, process.env.AGENT_PROXY_URL, { timeoutMillis: 5_000 });
      } catch {
        return null; // fail open: never let robots.txt loading break a crawl
      }
    })();
    robotsCache.set(origin, loading);
  }
  return robotsCache.get(origin);
}

// Pure, network-free core (parses robots.txt text directly) so the allow/deny
// logic is unit-testable without hitting the network.
export async function robotsTextAllows(robotsText, url) {
  try {
    const { RobotsTxtFile } = await import('crawlee');
    const origin = new URL(url).origin;
    const parsed = await RobotsTxtFile.from(`${origin}/robots.txt`, robotsText);
    return parsed.isAllowed(url);
  } catch {
    return true; // unparseable robots.txt → don't block
  }
}

export async function checkRobots(url, { mode } = {}) {
  const resolved = mode || resolveRobotsMode();
  if (resolved === 'off') return { allowed: true, mode: 'off' };
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return { allowed: true, mode: resolved };
  }
  const robots = await loadRobotsForOrigin(origin);
  if (!robots) return { allowed: true, mode: resolved }; // fail open
  let allowed = true;
  try {
    allowed = robots.isAllowed(url);
  } catch {
    allowed = true;
  }
  return { allowed, mode: resolved };
}

async function renderWithExecutable(executable, url, options = {}) {
  const profileDir = await mkdtemp(join(tmpdir(), 'agent-browser-'));
  const targetTimeoutMs = options.browserTimeoutMs ?? 30_000;
  const warmupTimeoutMs = options.browserWarmupTimeoutMs ?? 20_000;

  try {
    const origin = resolveOrigin(url);
    if (origin && origin !== url) {
      await dumpDomWithBrowser(executable, origin, profileDir, warmupTimeoutMs).catch(() => null);
    }

    const result = await dumpDomWithBrowser(executable, url, profileDir, targetTimeoutMs);
    const raw = result.stdout ?? '';
    if (result.code !== 0 && !isHtmlDocument(raw)) {
      const detail = (result.stderr || result.stdout || '').trim().slice(0, 300);
      throw new Error(detail ? `Browser fallback exited ${result.code}: ${detail}` : `Browser fallback exited ${result.code}`);
    }
    const producedDom = isHtmlDocument(raw);
    const usable = producedDom && !isLikelyBrowserErrorHtml(raw) && !isLikelyChallengeHtml(raw);
    return { html: usable ? raw : null, producedDom };
  } finally {
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function fetchHtmlWithBrowser(url, options = {}) {
  // Try the cached known-good browser first; otherwise walk the candidates.
  // An executable that exists but never produces a DOM (broken Edge installs
  // exit 0 with empty --dump-dom output) must not block the next candidate.
  // An error/challenge PAGE is a site-level block, not the browser's fault —
  // those candidates stay eligible.
  const candidates = workingBrowserExecutable
    ? [workingBrowserExecutable]
    : listBrowserExecutables().filter(exe => !brokenBrowserExecutables.has(exe));

  let lastError = null;
  for (const executable of candidates) {
    try {
      const { html, producedDom } = await renderWithExecutable(executable, url, options);
      if (html) {
        workingBrowserExecutable = executable;
        return html;
      }
      if (!producedDom) {
        brokenBrowserExecutables.add(executable);
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  return null;
}

export async function fetchHtml(url, options = {}) {
  const maxRetries = options.maxRetries ?? 2;
  const headers = { ...DEFAULT_HEADERS, ...(options.headers || {}) };
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.referer) headers.Referer = options.referer;

  // Politeness: consult robots.txt when enabled (default OFF → no change).
  const robotsMode = resolveRobotsMode();
  if (robotsMode !== 'off') {
    const { allowed } = await checkRobots(url, { mode: robotsMode });
    if (!allowed) {
      if (robotsMode === 'enforce') {
        const err = new Error(`robots.txt disallows ${url}`);
        err.nonRetryable = true;
        err.robotsBlocked = true;
        throw err;
      }
      // advisory 'log' mode: record what enforcement WOULD skip, then proceed.
      console.warn(`[robots:advisory] robots.txt would disallow (still fetching): ${url}`);
    }
  }

  // Force the headless-browser render (used as a retry when a plain fetch
  // returns a JS-rendered shell with no parseable posts).
  if (options.forceBrowser) {
    const html = await fetchHtmlWithBrowser(url, options);
    if (html) return html;
    throw new Error(`Browser render returned no usable HTML for ${url}`);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
      let res;
      try {
        res = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
          redirect: 'follow',
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        if (options.allowBrowserFallback !== false && BROWSER_BLOCK_STATUSES.has(res.status)) {
          // Escalate through the anti-bot tiers (got-scraping → browser → Crawlee),
          // which defeat VerticalScope-style WAFs the plain fetch can't.
          const { html: fallbackHtml, crawleeError } = await escalateBlockedFetch(url, options);
          if (fallbackHtml) return fallbackHtml;
          const fallbackDetail = crawleeError ? `; anti-bot fallback failed: ${crawleeError.message}` : '';
          const err = new Error(`HTTP ${res.status} fetching ${url}${fallbackDetail}`);
          err.nonRetryable = true;
          throw err;
        }

        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          await sleep(2_000 * (attempt + 1));
          continue;
        }

        // A 503 is often a Cloudflare "Just a moment…" challenge, not a real
        // outage — once retries are exhausted, give the browser fallback a shot
        // before failing (a genuine outage just fails there too, as before).
        if (options.allowBrowserFallback !== false && res.status === 503) {
          const { html: fallbackHtml } = await escalateBlockedFetch(url, options);
          if (fallbackHtml) return fallbackHtml;
        }

        throw new Error(`HTTP ${res.status} fetching ${url}`);
      }

      const html = await res.text();
      if (options.allowBrowserFallback !== false && isLikelyChallengeHtml(html)) {
        const { html: fallbackHtml, crawleeError } = await escalateBlockedFetch(url, options);
        if (fallbackHtml) return fallbackHtml;
        const fallbackDetail = crawleeError ? `: ${crawleeError.message}` : '';
        const err = new Error(`Browser challenge fallback failed for ${url}${fallbackDetail}`);
        err.nonRetryable = true;
        throw err;
      }

      return html;
    } catch (err) {
      if (err?.nonRetryable) throw err;
      if (attempt >= maxRetries) throw err;
      await sleep(2_000 * (attempt + 1));
    }
  }

  throw new Error(`Failed to fetch ${url}`);
}
