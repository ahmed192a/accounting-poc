import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPages, homeCards, splitBottomNav, isPageId, fallbackTitle } from '../public/lib/nav.js';
import { parseHash, buildHash, resolveRoute } from '../public/lib/router.js';

const cards = [
  { id: 'a', order: 50, page: 'banking', pageTitleKey: 'bank' },
  { id: 'b', order: 10, page: 'banking' },
  { id: 'c', order: 20, page: 'sales', pageTitleKey: 'sales' },
  { id: 'd', order: 5 },
];
test('nav: cards group by page, title from first card with a key, order by minimum card order', () => {
  const pages = buildPages(cards);
  assert.deepEqual(pages.map((p) => p.id), ['banking', 'sales']);
  assert.equal(pages[0].order, 10);
  assert.equal(pages[0].titleKey, 'bank');
  assert.deepEqual(pages[0].cardIds, ['b', 'a']);
});
test('nav: cards without page stay on Home; invalid page ids are ignored', () => {
  assert.deepEqual(homeCards(cards).map((c) => c.id), ['d']);
  assert.equal(buildPages([{ id: 'x', order: 1, page: 'Bad Id!' }]).length, 0);
  assert.ok(isPageId('tax-2') && !isPageId('../x'));
});
test('nav: full pages merge with card pages, respect permission and nav:false', () => {
  const pages = buildPages(cards, [
    { id: 'banking', titleKey: 'bankFull', order: 1, allowed: true },
    { id: 'rep', titleKey: 'rep', order: 30, allowed: true, nav: false },
    { id: 'secret', titleKey: 's', order: 2, allowed: false },
  ]);
  assert.deepEqual(pages.map((p) => p.id), ['banking', 'sales', 'rep']);
  assert.equal(pages[0].titleKey, 'bankFull'); assert.equal(pages[0].full, true);
  assert.equal(pages[2].nav, false);
});
test('nav: bottom bar keeps 4 plus More when there are more than 5', () => {
  assert.equal(splitBottomNav([1, 2, 3]).more.length, 0);
  const r = splitBottomNav([1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([r.bar.length, r.more.length], [4, 3]);
  assert.equal(fallbackTitle('my_page'), 'My page');
});
test('router: parse and build hashes round-trip', () => {
  assert.deepEqual(parseHash('').id, 'home');
  assert.equal(parseHash('#/').id, 'home');
  const r = parseHash('#/Banking/acc%201?x=1');
  assert.deepEqual([r.id, r.rest, r.query.x, r.valid], ['banking', ['acc 1'], '1', true]);
  assert.equal(buildHash('banking', ['acc 1'], { x: 1 }), '#/banking/acc%201?x=1');
  assert.equal(buildHash('home'), '#/');
});
test('router: unsafe ids are invalid and unknown pages are missing', () => {
  assert.equal(parseHash('#/<script>').valid, false);
  assert.equal(resolveRoute(parseHash('#/nope'), ['sales']).kind, 'missing');
  assert.equal(resolveRoute(parseHash('#/sales'), ['sales']).kind, 'page');
  assert.equal(resolveRoute(parseHash('#/'), []).kind, 'home');
});
