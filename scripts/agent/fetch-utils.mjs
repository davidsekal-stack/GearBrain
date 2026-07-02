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
          const { html: browserHtml } = await tryBrowserFallback(url, options);
          if (browserHtml) return browserHtml;
          // Escalate to the fingerprinted/proxied Crawlee browser — defeats
          // VerticalScope-style WAFs (403/406) that the system-Chrome dump can't.
          const { html: crawleeHtml, error: crawleeError } = await tryCrawleeFallback(url, options);
          if (crawleeHtml) return crawleeHtml;
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
          const { html: browserHtml } = await tryBrowserFallback(url, options);
          if (browserHtml) return browserHtml;
          const { html: crawleeHtml } = await tryCrawleeFallback(url, options);
          if (crawleeHtml) return crawleeHtml;
        }

        throw new Error(`HTTP ${res.status} fetching ${url}`);
      }

      const html = await res.text();
      if (options.allowBrowserFallback !== false && isLikelyChallengeHtml(html)) {
        const { html: browserHtml } = await tryBrowserFallback(url, options);
        if (browserHtml) return browserHtml;
        const { html: crawleeHtml, error: crawleeError } = await tryCrawleeFallback(url, options);
        if (crawleeHtml) return crawleeHtml;
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
