import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatPrice, formatReview, formatSigned, topReason, formatAge, capsuleFor } from '../public/format.js';

test('escapeHtml neutralizes markup and quotes used in attributes', () => {
  assert.equal(escapeHtml(`Baldur's <Gate> & "3"`), 'Baldur&#39;s &lt;Gate&gt; &amp; &quot;3&quot;');
  assert.equal(escapeHtml(null), '');
});

test('formatPrice', () => {
  assert.equal(formatPrice(null), '—');
  assert.equal(formatPrice(0), 'Free');
  assert.equal(formatPrice(2499), '$24.99');
});

test('formatReview and formatSigned', () => {
  assert.equal(formatReview(null), '—');
  assert.equal(formatReview(0.966), '97%');
  assert.equal(formatSigned(5), '+5');
  assert.equal(formatSigned(-3), '−3');
  assert.equal(formatSigned(0), '0');
});

test('topReason picks the largest positive line', () => {
  assert.equal(topReason([{ label: 'a', value: 3 }, { label: 'b', value: 9 }, { label: 'c', value: -20 }]), 'b');
  assert.equal(topReason([{ label: 'c', value: -2 }]), 'Matches your filters');
});

test('formatAge', () => {
  const day = 24 * 3600 * 1000;
  assert.equal(formatAge(1000), 'today');
  assert.equal(formatAge(day + 5), '1 day ago');
  assert.equal(formatAge(9 * day + 5), '9 days ago');
});

test('capsuleFor builds a CDN url', () => {
  assert.match(capsuleFor(10), /\/apps\/10\/capsule_184x69\.jpg$/);
});
