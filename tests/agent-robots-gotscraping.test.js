import assert from 'node:assert/strict';
import {
  resolveRobotsMode,
  robotsTextAllows,
  shouldAcceptFetchedHtml,
} from '../scripts/agent/fetch-utils.mjs';

// ── resolveRobotsMode: OFF by default, opt-in for log/enforce ──────────────
assert.equal(resolveRobotsMode({}), 'off', 'unset → off (crawl unchanged by default)');
assert.equal(resolveRobotsMode({ AGENT_ROBOTS_MODE: '' }), 'off');
assert.equal(resolveRobotsMode({ AGENT_ROBOTS_MODE: 'off' }), 'off');
assert.equal(resolveRobotsMode({ AGENT_ROBOTS_MODE: '0' }), 'off');
assert.equal(resolveRobotsMode({ AGENT_ROBOTS_MODE: 'nonsense' }), 'off', 'unknown → off (fail safe)');
assert.equal(resolveRobotsMode({ AGENT_ROBOTS_MODE: 'log' }), 'log');
assert.equal(resolveRobotsMode({ AGENT_ROBOTS_MODE: 'advisory' }), 'log');
assert.equal(resolveRobotsMode({ AGENT_ROBOTS_MODE: 'LOG' }), 'log', 'case-insensitive');
assert.equal(resolveRobotsMode({ AGENT_ROBOTS_MODE: 'enforce' }), 'enforce');
assert.equal(resolveRobotsMode({ AGENT_ROBOTS_MODE: ' Enforce ' }), 'enforce', 'trimmed + case-insensitive');
assert.equal(resolveRobotsMode({ AGENT_ROBOTS_MODE: '1' }), 'enforce');
assert.equal(resolveRobotsMode({ AGENT_ROBOTS_MODE: 'true' }), 'enforce');

// ── robotsTextAllows: pure parse of robots.txt text, no network ────────────
const ROBOTS = [
  'User-agent: *',
  'Disallow: /admin',
  'Disallow: /private',
  'Allow: /private/public',
].join('\n');

assert.equal(await robotsTextAllows(ROBOTS, 'https://forum.example.com/viewtopic.php?t=1'), true, 'normal thread allowed');
assert.equal(await robotsTextAllows(ROBOTS, 'https://forum.example.com/admin/panel'), false, '/admin disallowed');
assert.equal(await robotsTextAllows(ROBOTS, 'https://forum.example.com/private/x'), false, '/private disallowed');
assert.equal(await robotsTextAllows('', 'https://forum.example.com/anything'), true, 'empty robots → allow all');
assert.equal(await robotsTextAllows('User-agent: *\nDisallow: /', 'https://forum.example.com/x'), false, 'blanket Disallow: / blocks everything');
assert.equal(await robotsTextAllows('%%%not valid%%%', 'https://forum.example.com/x'), true, 'garbage robots → allow (never break the crawl)');

// ── shouldAcceptFetchedHtml: only clean 2xx HTML documents count as usable ──
const REAL = '<!doctype html><html><body><div class="post">text</div></body></html>';
const CHALLENGE = '<html><title>Just a moment...</title><body>Checking your browser before accessing</body></html>';
const ERRPAGE = '<html><body><main id="main-frame-error">This site can’t be reached ERR_TIMED_OUT</main></body></html>';

assert.equal(shouldAcceptFetchedHtml(200, REAL), true, '200 + real HTML → accept');
assert.equal(shouldAcceptFetchedHtml(null, REAL), true, 'unknown status + real HTML → accept');
assert.equal(shouldAcceptFetchedHtml(403, REAL), false, '403 → reject');
assert.equal(shouldAcceptFetchedHtml(500, REAL), false, '5xx → reject');
assert.equal(shouldAcceptFetchedHtml(200, CHALLENGE), false, '200 but WAF challenge → reject');
assert.equal(shouldAcceptFetchedHtml(200, ERRPAGE), false, '200 but browser error page → reject');
assert.equal(shouldAcceptFetchedHtml(200, 'just some text, not html'), false, 'non-HTML body → reject');
assert.equal(shouldAcceptFetchedHtml(200, ''), false, 'empty body → reject');

console.log('agent-robots-gotscraping.test.js passed');
