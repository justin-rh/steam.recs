import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { createCatalog, FRESH_MS, PER_TAG, GEMS_PER_TAG, pickGems } from '../lib/catalog.js';

const passthrough = { run: fn => fn() };
const silent = { warn() {}, error() {} };

function fakes({ tagLists = {}, top2 = [], failApp = null, listsFail = false } = {}) {
  const calls = { spyDetails: [], storeDetails: [], deck: [], lists: [] };
  const spy = {
    async getAppDetails(appid) {
      calls.spyDetails.push(appid);
      if (appid === failApp) throw new Error('boom');
      const tags = appid === 1 ? { Roguelike: 10, Action: 5 } : appid === 2 ? { Puzzle: 10 } : { Roguelike: 3 };
      return { appid, name: `App ${appid}`, tags, developer: 'D', publisher: 'P', priceCents: 999, reviewPct: 0.9, reviewCount: 100 };
    },
    async listByTag(tag) { calls.lists.push(tag); if (listsFail) throw new Error('lists down'); return tagLists[tag] || []; },
    async listTop2Weeks() { calls.lists.push('top2'); if (listsFail) throw new Error('lists down'); return top2; },
  };
  const steam = {
    async getAppDetails(appid) { calls.storeDetails.push(appid); return { name: `App ${appid}`, releaseYear: 2020, modes: ['single'], priceCents: 1999, capsuleUrl: 'c' }; },
    async getDeckVerified(appid) { calls.deck.push(appid); return true; },
  };
  return { spy, steam, calls };
}

function setup(opts) {
  const store = createStore();
  store.importOwned([{ appid: 1, name: 'Seeded', hours: 10 }]);
  store.addGame({ appid: 2, name: 'Unseeded', position: 1 });
  store.setSeed(2, false);
  const f = fakes(opts);
  let t = 1_000_000;
  const catalog = createCatalog({ store, steam: f.steam, spy: f.spy, spyThrottle: passthrough, storeThrottle: passthrough, now: () => t, log: silent });
  return { store, catalog, ...f, advance: ms => { t += ms; } };
}

const row = (appid, positive) => ({ appid, name: `C${appid}`, positive, negative: 0 });

test('refresh fetches seeded tags, builds candidates from top tags, excludes owned, fetches details', async () => {
  const { store, catalog, calls } = setup({
    tagLists: { Roguelike: [row(10, 5), row(11, 50), row(1, 999)], Action: [row(12, 1)] },
    top2: [row(13, 1)],
  });
  await catalog.refresh();
  assert.deepEqual(calls.lists, ['top2', 'Roguelike', 'Action']);
  const ids = store.getValue('candidateIds', []);
  assert.deepEqual([...ids].sort((a, b) => a - b), [10, 11, 12, 13]);
  assert.deepEqual([...calls.storeDetails].sort((a, b) => a - b), [10, 11, 12, 13]);
  assert.ok(calls.spyDetails.includes(2), 'non-seeded library game gets tags last');
  assert.equal(calls.spyDetails.at(-1), 2);
  const app = store.getApp(10);
  assert.equal(app.deckVerified, true);
  assert.equal(app.priceCents, 1999);
  const st = catalog.status();
  assert.equal(st.running, false);
  assert.equal(st.candidateCount, 4);
  assert.equal(st.failed, 0);
  assert.equal(st.stale, false);
});

test('only the top PER_TAG games by positive reviews are taken per tag', async () => {
  const many = Array.from({ length: PER_TAG + 10 }, (_, i) => row(100 + i, i));
  const { store, catalog } = setup({ tagLists: { Roguelike: many } });
  await catalog.refresh();
  const ids = new Set(store.getValue('candidateIds', []));
  assert.equal(ids.size, PER_TAG);
  assert.ok(ids.has(100 + PER_TAG + 9));
  assert.ok(!ids.has(100));
});

test('pickGems keeps 50–5,000 reviews at 85%+ positive, best ratio first, capped per tag', () => {
  const r = (appid, positive, negative) => ({ appid, name: `G${appid}`, positive, negative });
  const list = [
    r(1, 40, 0),        // too few reviews
    r(2, 90, 10),       // 90% of 100 → keep
    r(3, 5700, 300),    // too many reviews
    r(4, 800, 200),     // 80% → below ratio
    r(5, 990, 10),      // 99% of 1000 → keep, ranks first
    r(6, 85, 15),       // exactly 85% → keep
  ];
  assert.deepEqual(pickGems(list).map(g => g.appid), [5, 2, 6]);
  const many = Array.from({ length: GEMS_PER_TAG + 5 }, (_, i) => r(100 + i, 100, 0));
  assert.equal(pickGems(many).length, GEMS_PER_TAG);
});

test('refresh adds hidden gems beyond the most-reviewed games for each tag', async () => {
  const popular = Array.from({ length: PER_TAG }, (_, i) => row(100 + i, 100_000 + i));
  const gem = { appid: 999, name: 'Gem', positive: 300, negative: 10 };
  const { store, catalog } = setup({ tagLists: { Roguelike: [...popular, gem] } });
  await catalog.refresh();
  const ids = new Set(store.getValue('candidateIds', []));
  assert.ok(ids.has(999));
  assert.equal(ids.size, PER_TAG + 1);
});

test('second refresh within 7 days skips fresh apps; after 7 days refetches', async () => {
  const { catalog, calls, advance } = setup({ tagLists: { Roguelike: [row(10, 1)] } });
  await catalog.refresh();
  const before = calls.storeDetails.length;
  await catalog.refresh();
  assert.equal(calls.storeDetails.length, before);
  advance(FRESH_MS + 1);
  await catalog.refresh();
  assert.equal(calls.storeDetails.length, before + 1);
});

test('a failing app is counted and the build continues', async () => {
  const { catalog, store } = setup({ tagLists: { Roguelike: [row(10, 1), row(11, 2)] }, failApp: 10 });
  await catalog.refresh();
  assert.equal(catalog.status().failed, 1);
  assert.equal(store.getApp(11).deckVerified, true);
});

test('list failure falls back to cached candidates and reports the error', async () => {
  const { catalog, store } = setup({ listsFail: true });
  store.setValue('candidateIds', [10]);
  await catalog.refresh();
  const st = catalog.status();
  assert.match(st.error, /cached candidate list/);
  assert.deepEqual(store.getValue('candidateIds', []), [10]);
  assert.equal(store.getApp(10).deckVerified, true);
});

test('list failure with no cache sets error and stops cleanly', async () => {
  const { catalog } = setup({ listsFail: true });
  await catalog.refresh();
  const st = catalog.status();
  assert.equal(st.running, false);
  assert.match(st.error, /lists down/);
});

test('refresh returns null while a build is running', async () => {
  const { catalog } = setup({ tagLists: {} });
  const first = catalog.refresh();
  assert.equal(catalog.refresh(), null);
  await first;
});

test('ensureApp fetches tags and details for one app', async () => {
  const { catalog, store } = setup({});
  const app = await catalog.ensureApp(55);
  assert.equal(app.appid, 55);
  assert.deepEqual(store.getApp(55).tags, { Roguelike: 3 });
  assert.equal(store.getApp(55).releaseYear, 2020);
});
