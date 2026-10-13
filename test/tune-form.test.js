import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFilters, writeFilters } from '../public/ui/tune-form.js';
import { mergeSettings } from '../public/score.js';

const blankForm = () => ({
  maxPrice: { value: '' }, minReviewPct: { value: '' }, minReviewCount: { value: '' },
  yearMin: { value: '' }, yearMax: { value: '' }, deckOnly: { checked: false },
  mode: { value: 'any' }, hideWishlisted: { checked: false }, hideTriaged: { checked: true },
  obscurity: { value: '0' }, englishOnly: { checked: false }, combineSeries: { checked: true },
});

test('combineSeries checkbox reads and round-trips', () => {
  const f = blankForm();
  assert.equal(readFilters(f).combineSeries, true);
  f.combineSeries.checked = false;
  assert.equal(readFilters(f).combineSeries, false);
  writeFilters(f, mergeSettings());
  assert.equal(f.combineSeries.checked, true);
});

test('englishOnly checkbox reads and round-trips', () => {
  const f = blankForm();
  f.englishOnly.checked = true;
  assert.equal(readFilters(f).filters.englishOnly, true);
  writeFilters(f, mergeSettings({ filters: { englishOnly: false } }));
  assert.equal(f.englishOnly.checked, false);
});

test('obscurity slider reads as an integer and round-trips', () => {
  const f = blankForm();
  f.obscurity.value = '-2';
  assert.equal(readFilters(f).obscurity, -2);
  writeFilters(f, mergeSettings({ obscurity: 1 }));
  assert.equal(f.obscurity.value, '1');
  assert.equal(readFilters(f).obscurity, 1);
});

test('blank fields mean no limit', () => {
  const out = readFilters(blankForm());
  assert.deepEqual(out.filters, { maxPriceCents: null, minReviewPct: null, minReviewCount: null, yearMin: null, yearMax: null, deckOnly: false, mode: 'any', englishOnly: false });
  assert.equal(out.hideTriaged, true);
});

test('0 max price means free only; percents and dollars convert', () => {
  const f = blankForm();
  f.maxPrice.value = '0';
  f.minReviewPct.value = '85';
  f.yearMin.value = '2015';
  assert.equal(readFilters(f).filters.maxPriceCents, 0);
  assert.equal(readFilters(f).filters.minReviewPct, 0.85);
  f.maxPrice.value = '19.99';
  assert.equal(readFilters(f).filters.maxPriceCents, 1999);
  assert.equal(readFilters(f).filters.yearMin, 2015);
});

test('non-numeric or negative input is treated as blank', () => {
  const f = blankForm();
  f.maxPrice.value = 'abc';
  f.minReviewCount.value = '-5';
  const out = readFilters(f).filters;
  assert.equal(out.maxPriceCents, null);
  assert.equal(out.minReviewCount, null);
});

test('writeFilters round-trips through readFilters', () => {
  const settings = mergeSettings({ filters: { maxPriceCents: 1999, minReviewPct: 0.8, deckOnly: true, mode: 'coop' }, hideWishlisted: true });
  const f = blankForm();
  writeFilters(f, settings);
  assert.equal(f.maxPrice.value, '19.99');
  assert.equal(f.minReviewPct.value, '80');
  const back = readFilters(f);
  assert.deepEqual(back.filters, settings.filters);
  assert.equal(back.hideWishlisted, true);
});
