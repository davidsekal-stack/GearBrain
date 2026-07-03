import assert from 'node:assert/strict';
import { enumerateThreadUrls } from '../scripts/agent/crawl.mjs';
import { findNextPageLink } from '../scripts/agent/parsers/common.mjs';

const forum = {
  url: 'https://example.com/forum',
  sections_json: JSON.stringify(['https://example.com/forum']),
};

const page1 = `
  <a href="/viewtopic.php?f=1&t=100&sid=abc123">First solved thread</a>
  <a class="next" href="/forum?page=2&sid=abc123">Next</a>
`;

const page2 = `
  <a href="/viewtopic.php?f=1&t=200&sid=def456">Second solved thread</a>
`;

const fetchCalls = [];
const urls = await enumerateThreadUrls(
  forum,
  {},
  10,
  0,
  {
    fetchHtmlImpl: async (url) => {
      fetchCalls.push(url);
      if (url === 'https://example.com/forum') return page1;
      if (url === 'https://example.com/forum?page=2') return page2;
      throw new Error(`Unexpected URL: ${url}`);
    },
  }
);

assert.deepEqual(fetchCalls, [
  'https://example.com/forum',
  'https://example.com/forum?page=2',
]);

assert.deepEqual(
  urls.map(link => link.url),
  [
    'https://example.com/viewtopic.php?f=1&t=100',
    'https://example.com/viewtopic.php?f=1&t=200',
  ]
);

// ── findNextPageLink engine patterns ────────────────────────────────────────
// WoltLab publishes listing pagination ONLY as <link rel="next"> in the head
// (RenaultForum.net, PeugeotTalk.de) — the body next-button has no matchable
// class/rel. Regression guard: whole forums were falsely "archive complete"
// after 1 page per section (review 2026-07-02).
assert.equal(
  findNextPageLink(
    `<head><link rel="next" href="https://renaultforum.net/board/62-renault-clio-mechanik/?pageNo=2"></head><body></body>`,
    'https://renaultforum.net/board/62-renault-clio-mechanik/'
  ),
  'https://renaultforum.net/board/62-renault-clio-mechanik/?pageNo=2',
  'WoltLab <link rel="next"> in head'
);
assert.equal(
  findNextPageLink(
    `<link href="/board/62/?pageNo=3" rel="next">`,
    'https://renaultforum.net/board/62/?pageNo=2'
  ),
  'https://renaultforum.net/board/62/?pageNo=3',
  '<link rel="next"> with reversed attribute order'
);

// SMF: the next-page link is the navPages anchor with the » glyph; NUMBERED
// navPages anchors must not be taken as "next".
const smfListing = `
  <a class="navPages" href="https://forum.example.sk/index.php/board,149.20.html?PHPSESSID=abc">2</a>
  <a class="navPages" href="https://forum.example.sk/index.php/board,149.40.html?PHPSESSID=abc">3</a>
  <a class="navPages" href="https://forum.example.sk/index.php/board,149.20.html?PHPSESSID=abc">&raquo;</a>
`;
assert.equal(
  findNextPageLink(smfListing, 'https://forum.example.sk/index.php/board,149.0.html'),
  'https://forum.example.sk/index.php/board,149.20.html?PHPSESSID=abc',
  'SMF navPages » anchor is the next page'
);
assert.equal(
  findNextPageLink(
    `<a class="navPages" href="https://forum.example.sk/index.php/board,149.0.html">1</a>`,
    'https://forum.example.sk/index.php/board,149.20.html'
  ),
  null,
  'SMF last page (numbered links only, no ») → no next'
);

// Text-labelled next button with a pagination-shaped href (kia-club.org phpBB
// skin) — no class, no rel, just the label.
assert.equal(
  findNextPageLink(
    `<a href="./viewforum.php?f=22&amp;sid=a0be&amp;start=25">2</a>
     <a href="./viewforum.php?f=22&amp;sid=a0be&amp;start=25" class="right-box right">Další</a>`,
    'https://www.kia-club.org/viewforum.php?f=22'
  ),
  'https://www.kia-club.org/viewforum.php?f=22&sid=a0be&start=25',
  'text-labelled next (Další) with pagination href'
);
// …but a "next topic" style link (no pagination params in href) must NOT match,
// and numbered page links must not match either.
assert.equal(
  findNextPageLink(
    `<a href="./viewtopic.php?f=22&amp;t=999">Další téma</a>
     <a href="./viewforum.php?f=22&amp;start=25">2</a>`,
    'https://www.kia-club.org/viewforum.php?f=22'
  ),
  null,
  'text-next never matches non-pagination hrefs or bare numbers'
);

// ── Numbered pagination (Snitz / BMW-Syndikat: no "next" anchor) ─────────────
// Off by default (opts.numbered absent) — the numbered links must NOT be taken.
const snitz = `
  <a class="mobile_big_paging" href="forum70w2_Codierung.html" title="Seite 2">2</a>
  <a class="mobile_big_paging" href="forum70w3_Codierung.html" title="Seite 3">3</a>
  <a class="mobile_big_paging" href="forum70w133_Codierung.html" title="Seite 133">133</a>
`;
assert.equal(
  findNextPageLink(snitz, 'https://bmw-syndikat.de/forum70_Codierung.html'),
  null,
  'numbered links are NOT followed unless the profile opts in',
);
// Opted in: page 1 (no wN) → next is w2.
assert.equal(
  findNextPageLink(snitz, 'https://bmw-syndikat.de/forum70_Codierung.html', null, { numbered: true, numberRe: 'w(\\d+)_' }),
  'https://bmw-syndikat.de/forum70w2_Codierung.html',
  'numbered: page 1 → w2 (current+1)',
);
// On page 2 → next is w3 (not w133, not w2 again — must be exactly current+1).
assert.equal(
  findNextPageLink(snitz, 'https://bmw-syndikat.de/forum70w2_Codierung.html', null, { numbered: true, numberRe: 'w(\\d+)_' }),
  'https://bmw-syndikat.de/forum70w3_Codierung.html',
  'numbered: page 2 → w3',
);
// Last page: no current+1 candidate → null → section done (no infinite loop).
assert.equal(
  findNextPageLink(
    `<a class="mobile_big_paging" href="forum70w132_Codierung.html">132</a>`,
    'https://bmw-syndikat.de/forum70w133_Codierung.html', null,
    { numbered: true, numberRe: 'w(\\d+)_' },
  ),
  null,
  'numbered: last page has no current+1 link → done',
);

console.log('agent-crawl-pagination.test.js passed');
