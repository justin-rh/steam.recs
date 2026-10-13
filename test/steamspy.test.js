import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSteamSpyClient } from '../lib/steamspy.js';

const fetchReturning = body => async () => ({ ok: true, status: 200, json: async () => body });

test('getAppDetails normalizes tags, reviews, and price', async () => {
  const spy = createSteamSpyClient({ fetch: fetchReturning({
    appid: 1, name: 'Hades', developer: 'Supergiant Games', publisher: 'Supergiant Games',
    positive: 900, negative: 100, price: '2499', tags: { Roguelike: 5000, Action: 3000 },
  }) });
  assert.deepEqual(await spy.getAppDetails(1), {
    appid: 1, name: 'Hades', tags: { Roguelike: 5000, Action: 3000 }, developer: 'Supergiant Games',
    publisher: 'Supergiant Games', priceCents: 2499, reviewPct: 0.9, reviewCount: 1000, languages: null,
  });
});

test('getAppDetails turns SteamSpy empty-array tags into {} and zero reviews into null pct', async () => {
  const spy = createSteamSpyClient({ fetch: fetchReturning({ appid: 2, name: 'New', positive: 0, negative: 0, price: '', tags: [] }) });
  const d = await spy.getAppDetails(2);
  assert.deepEqual(d.tags, {});
  assert.equal(d.reviewPct, null);
  assert.equal(d.priceCents, null);
});

test('getAppDetails parses the languages list; blank means unknown (null)', async () => {
  const withLangs = createSteamSpyClient({ fetch: fetchReturning({ appid: 4, name: 'L', positive: 1, negative: 0, tags: {}, languages: 'English, French,  Simplified Chinese' }) });
  assert.deepEqual((await withLangs.getAppDetails(4)).languages, ['English', 'French', 'Simplified Chinese']);
  const blank = createSteamSpyClient({ fetch: fetchReturning({ appid: 5, name: 'B', positive: 1, negative: 0, tags: {}, languages: '' }) });
  assert.equal((await blank.getAppDetails(5)).languages, null);
  const missing = createSteamSpyClient({ fetch: fetchReturning({ appid: 6, name: 'M', positive: 1, negative: 0, tags: {} }) });
  assert.equal((await missing.getAppDetails(6)).languages, null);
});

test('getAppDetails returns null for unknown apps', async () => {
  const spy = createSteamSpyClient({ fetch: fetchReturning({ appid: 3, name: null }) });
  assert.equal(await spy.getAppDetails(3), null);
});

test('listByTag maps the appid-keyed object to an array', async () => {
  const spy = createSteamSpyClient({ fetch: fetchReturning({
    10: { appid: 10, name: 'A', positive: 5, negative: 1 },
    20: { appid: 20, name: 'B', positive: 50, negative: 2 },
  }) });
  const list = await spy.listByTag('Open World');
  assert.deepEqual(list.map(r => r.appid).sort(), [10, 20]);
  assert.equal(list.find(r => r.appid === 20).positive, 50);
});
