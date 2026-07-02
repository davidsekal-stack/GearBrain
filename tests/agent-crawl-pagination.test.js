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

console.log('agent-crawl-pagination.test.js passed');
