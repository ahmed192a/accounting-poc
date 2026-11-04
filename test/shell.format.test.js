import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmountToPiastres, toWesternDigits, formatMoney, localeTag, normalizeDigits } from '../public/lib/format.js';

test('format: parses Latin and Arabic-Indic amounts to integer piastres', () => {
  assert.equal(parseAmountToPiastres('12.5'), 1250);
  assert.equal(parseAmountToPiastres('١٢٫٥٠'), 1250);
  assert.equal(parseAmountToPiastres('1,234.56'), 123456);
  assert.equal(parseAmountToPiastres('12,5'), 1250);
  assert.equal(parseAmountToPiastres(''), 0);
});
test('format: rounds half up without float error and rejects junk', () => {
  assert.equal(parseAmountToPiastres('1.005'), 101);
  assert.equal(parseAmountToPiastres('1.004'), 100);
  assert.equal(parseAmountToPiastres('-2.50'), -250);
  assert.ok(Number.isNaN(parseAmountToPiastres('abc')));
  assert.ok(Number.isNaN(parseAmountToPiastres('.')));
});
test('format: digit mode picks the numbering system', () => {
  assert.equal(localeTag('ar', 'latn'), 'ar-EG-u-nu-latn');
  assert.equal(localeTag('en'), 'en-US');
  assert.equal(normalizeDigits('x'), 'auto');
  assert.match(formatMoney(123456, 'en', 'latn'), /^1,234\.56 EGP$/);
  assert.match(formatMoney(123456, 'ar', 'arab'), /[٠-٩]/);
  assert.match(formatMoney(123456, 'ar', 'latn'), /1.234.56/);
  assert.equal(formatMoney(NaN, 'en'), '—');
  assert.equal(toWesternDigits('٠١٢٣۴'), '01234');
});
