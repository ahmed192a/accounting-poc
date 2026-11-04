import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseAmount, parseDate, mapStatement, inspectCsv, normalizeMethod } from '../src/modules/banking/csv.js';

const MAP = { dateCol: 'Date', dateFormat: 'YYYY-MM-DD', descriptionCol: 'Description', amountCol: 'Amount' };

test('csv: quoted commas, escaped quotes and newlines inside quotes, CRLF, BOM', () => {
  const text = '﻿Date,Description,Amount\r\n2026-01-05,"Fawry, bill ""A""",-100.50\r\n2026-01-06,"line one\nline two",20\r\n';
  const { records, error } = parseCsv(text, ',');
  assert.equal(error, null);
  assert.equal(records.length, 3);
  assert.equal(records[0].cells[0], 'Date', 'BOM stripped from the first header');
  assert.equal(records[1].cells[1], 'Fawry, bill "A"');
  assert.equal(records[2].cells[1], 'line one\nline two');
  assert.equal(records[2].line, 3);
  const m = mapStatement(text, MAP, 1);
  assert.deepEqual(m.errors, []);
  assert.deepEqual(m.lines.map((l) => l.amount), [-10050, 2000]);
});

test('csv: unterminated quote is reported with its line', () => {
  const { error } = parseCsv('a,b\n1,"oops\n2,3\n', ',');
  assert.equal(error.line, 2);
});

test('csv: amounts with Arabic-Indic digits, separators, parentheses and trailing minus become integer piastres', () => {
  assert.equal(parseAmount('١٬٢٣٤٫٥٠'), 123450);
  assert.equal(parseAmount('۱۲۳٫۰۵'), 12305);
  assert.equal(parseAmount('1,234.50'), 123450);
  assert.equal(parseAmount('1.234,50'), 123450);
  assert.equal(parseAmount('12,5', ','), 1250);
  assert.equal(parseAmount('(100.00)'), -10000);
  assert.equal(parseAmount('100-'), -10000);
  assert.equal(parseAmount('EGP 75'), 7500);
  assert.equal(parseAmount(''), null);
  assert.throws(() => parseAmount('12abc'), /not a valid amount/);
  assert.throws(() => parseAmount('1.005'.replace('.', ',') + '5', ','), /decimal places/);
});

test('csv: dates in several formats and Arabic digits; impossible dates refused', () => {
  assert.equal(parseDate('05/03/2026', 'DD/MM/YYYY'), '2026-03-05');
  assert.equal(parseDate('03/05/2026', 'MM/DD/YYYY'), '2026-03-05');
  assert.equal(parseDate('٠٥-٠٣-٢٠٢٦', 'DD-MM-YYYY'), '2026-03-05');
  assert.equal(parseDate('2026-03-05 14:22:00', 'YYYY-MM-DD'), '2026-03-05');
  assert.throws(() => parseDate('31/02/2026', 'DD/MM/YYYY'), /real calendar date/);
  assert.throws(() => parseDate('5/3/26', 'D/M/YYYY'), /4-digit year/);
});

test('csv: separate debit/credit columns; both filled or both empty are row errors', () => {
  const text = 'Date;Narrative;Debit;Credit\n2026-01-01;Fee;10,00;\n2026-01-02;Deposit;;250,00\n2026-01-03;Both;5;5\n2026-01-04;Neither;;\n';
  const m = mapStatement(text, { dateCol: 'Date', descriptionCol: 'Narrative', debitCol: 'Debit', creditCol: 'Credit', decimal: ',' }, 1);
  assert.equal(m.delimiter, ';');
  assert.deepEqual(m.lines.map((l) => l.amount), [-1000, 25000]);
  assert.deepEqual(m.errors.map((e) => e.row), [4, 5]);
});

test('csv: malformed rows are reported with row numbers and good rows still parse', () => {
  const text = 'Date,Description,Amount\n2026-01-01,ok,10\nnot-a-date,bad date,5\n2026-01-03,bad amount,abc\n2026-01-04,short\n2026-01-05,fine,7\n';
  const m = mapStatement(text, MAP, 1);
  assert.equal(m.lines.length, 2);
  assert.deepEqual(m.errors.map((e) => e.row), [3, 4, 5]);
  assert.match(m.errors[0].message, /Date/);
  assert.match(m.errors[1].message, /Amount/);
  assert.match(m.errors[2].message, /columns/);
});

test('csv: identical rows inside one file are kept (numbered), and hashes are stable across runs', () => {
  const text = 'Date,Description,Amount\n2026-01-01,Coffee,-5\n2026-01-01,Coffee,-5\n';
  const a = mapStatement(text, MAP, 1), b = mapStatement(text, MAP, 1), other = mapStatement(text, MAP, 2);
  assert.equal(a.lines.length, 2);
  assert.notEqual(a.lines[0].hash, a.lines[1].hash);
  assert.deepEqual(a.lines.map((l) => l.hash), b.lines.map((l) => l.hash));
  assert.notEqual(a.lines[0].hash, other.lines[0].hash, 'hash is per account');
});

test('csv: mapping errors throw, inspect suggests a mapping, methods normalise', () => {
  assert.throws(() => mapStatement('a,b\n1,2\n', { dateCol: 'Nope', amountCol: 'b' }, 1), /not found/);
  assert.throws(() => mapStatement('a,b\n1,2\n', { dateCol: 'a' }, 1), /amountCol/);
  const i = inspectCsv('Date,Description,Debit,Credit,Balance\n05/03/2026,x,1,,9\n');
  assert.equal(i.suggested.debitCol, 'Debit');
  assert.equal(i.suggested.dateFormat, 'DD/MM/YYYY');
  assert.equal(normalizeMethod('InstaPay transfer'), 'instapay');
  assert.equal(normalizeMethod('Vodafone wallet'), 'wallet');
  assert.equal(normalizeMethod('weird'), 'other');
});
