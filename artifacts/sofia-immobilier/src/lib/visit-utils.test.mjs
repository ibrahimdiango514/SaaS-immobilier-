import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatVisitDate,
  localDateKey,
  visitDateBucket,
  visitDateKey,
} from './visit-utils.js';

test('normalizes a date-only value and keeps its calendar day when an ISO time is present', () => {
  assert.equal(visitDateKey('2026-10-17'), '2026-10-17');
  assert.equal(visitDateKey(' 2026-10-17T00:00:00.000Z '), '2026-10-17');
});

test('rejects missing and impossible calendar dates, including non-leap February 29', () => {
  assert.equal(visitDateKey(null), null);
  assert.equal(visitDateKey(''), null);
  assert.equal(visitDateKey('17/10/2026'), null);
  assert.equal(visitDateKey('2026-10-17-not-a-date'), null);
  assert.equal(visitDateKey('2026-02-29'), null);
  assert.equal(visitDateKey('2026-04-31'), null);
  assert.equal(visitDateKey('2024-02-29'), '2024-02-29');
});

test('classifies a visit against a date key without shifting it across time zones', () => {
  assert.equal(visitDateBucket('2026-10-16', '2026-10-17'), 'past');
  assert.equal(visitDateBucket('2026-10-17', '2026-10-17'), 'today');
  assert.equal(visitDateBucket('2026-10-18', '2026-10-17'), 'upcoming');
  assert.equal(visitDateBucket('invalid', '2026-10-17'), null);
});

test('creates a local date key and formats visits using the calendar date in UTC', () => {
  const localDate = new Date(2026, 9, 17, 23, 45);
  assert.equal(localDateKey(localDate), '2026-10-17');
  assert.equal(localDateKey(new Date(Number.NaN)), null);
  assert.equal(formatVisitDate('2026-10-17'), 'samedi 17 octobre 2026');
  assert.equal(formatVisitDate('not-a-date'), 'Date à vérifier');
});
