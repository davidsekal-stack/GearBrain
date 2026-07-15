import assert from 'node:assert/strict';

const { applyRaise, applyClear, openIssues, render } = await import('../scripts/agent/operator-inbox.mjs');

function testRaiseNewThenRecur() {
  const inbox = { issues: {} };
  applyRaise(inbox, { key: 'coach-incomplete', title: 'Ranní běh se nedokončuje', detail: 'd', fix: 'f' }, new Date('2026-07-12T04:00:00Z'));
  assert.equal(inbox.issues['coach-incomplete'].days, 1, 'first raise → day 1');

  // same day again → idempotent (no day bump)
  applyRaise(inbox, { key: 'coach-incomplete', title: 'Ranní běh se nedokončuje' }, new Date('2026-07-12T09:00:00Z'));
  assert.equal(inbox.issues['coach-incomplete'].days, 1, 'same-day re-raise does not bump the day count');

  // next day → bump
  applyRaise(inbox, { key: 'coach-incomplete', title: 'Ranní běh se nedokončuje' }, new Date('2026-07-13T04:00:00Z'));
  applyRaise(inbox, { key: 'coach-incomplete', title: 'Ranní běh se nedokončuje' }, new Date('2026-07-14T04:00:00Z'));
  assert.equal(inbox.issues['coach-incomplete'].days, 3, 'a new day bumps the recurrence counter');
  assert.equal(inbox.issues['coach-incomplete'].firstSeen.slice(0, 10), '2026-07-12', 'firstSeen preserved across recurrences');
}

function testClear() {
  const inbox = { issues: {} };
  applyRaise(inbox, { key: 'x', title: 'X' });
  assert.equal(applyClear(inbox, 'x'), true, 'clearing an open issue returns true');
  assert.equal(applyClear(inbox, 'x'), false, 'clearing a missing issue returns false');
  assert.deepEqual(inbox.issues, {}, 'cleared issue is gone');
}

function testOrderingMostRecurringFirst() {
  const inbox = { issues: {} };
  applyRaise(inbox, { key: 'a', title: 'A' }, new Date('2026-07-14T04:00:00Z'));
  applyRaise(inbox, { key: 'b', title: 'B' }, new Date('2026-07-10T04:00:00Z'));
  applyRaise(inbox, { key: 'b', title: 'B' }, new Date('2026-07-11T04:00:00Z')); // b → 2 days
  const order = openIssues(inbox).map(i => i.key);
  assert.deepEqual(order, ['b', 'a'], 'most-recurring (higher day count) first');
}

function testRenderEmptyAndFull() {
  const empty = render({ issues: {} });
  assert.match(empty, /Nic — vše běží/, 'empty inbox renders the all-good line');

  const inbox = { issues: {} };
  applyRaise(inbox, { key: 'coach-incomplete', title: 'Ranní běh se nedokončuje', detail: 'Narazí na 4h limit.', fix: 'Sloučit triáž a review.' }, new Date('2026-07-12T04:00:00Z'));
  applyRaise(inbox, { key: 'coach-incomplete', title: 'Ranní běh se nedokončuje' }, new Date('2026-07-13T04:00:00Z'));
  const md = render(inbox);
  assert.match(md, /Co potřebuje tvé rozhodnutí/, 'has heading');
  assert.match(md, /Ranní běh se nedokončuje/, 'shows the issue title');
  assert.match(md, /už 2 dní/, 'shows recurrence');
  assert.match(md, /Můj návrh:.*Sloučit/, 'shows the proposed fix');
}

testRaiseNewThenRecur();
testClear();
testOrderingMostRecurringFirst();
testRenderEmptyAndFull();

console.log('agent-operator-inbox.test.js passed');
