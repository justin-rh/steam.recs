import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { createCatalog, FRESH_MS, PER_TAG, GEMS_PER_TAG, TOP_TAGS, pickGems, wilsonLowerBound } from '../lib/catalog.js';

const passthrough = { run: fn => fn() };
const silent = { warn() {}, error() {} };

function fakes({ tagLists = {}, top2 = [], failApp = null, listsFail = false, seedTags = { Roguelike: 10, Action: 5 } } = {}) {
  const calls = { spyDetails: [], storeDetails: [], deck: [], lists: [] };
  const spy = {
    async getAppDetails(appid) {
      calls.spyDetails.push(appid);
      if (appid === failApp) throw new Error('boom');
      const tags = appid === 1 ? seedTags : appid === 2 ? { Puzzle: 10 } : { Roguelike: 3 };
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
  const catalog = createCatalog({
    store, steam: f.steam, spy: f.spy, now: () => t, log: silent,
    spyThrottle: opts?.spyThrottle || passthrough, storeThrottle: opts?.storeThrottle || passthrough,
  });
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
  const many = Array.from({ length: PER_TAG + 10 }, (_, i) => ({ appid: 100 + i, name: `C${100 + i}`, positive: i, negative: i }));
  const { store, catalog } = setup({ tagLists: { Roguelike: many } });
  await catalog.refresh();
  const ids = new Set(store.getValue('candidateIds', []));
  assert.equal(ids.size, PER_TAG);
  assert.ok(ids.has(100 + PER_TAG + 9));
  assert.ok(!ids.has(100));
});

test('wilsonLowerBound ranks a well-reviewed large sample above a tiny perfect one', () => {
  assert.ok(wilsonLowerBound(1960, 2000) > wilsonLowerBound(20, 20));
  assert.ok(Math.abs(wilsonLowerBound(20, 20) - 20 / (20 + 1.96 ** 2)) < 1e-9);
  assert.equal(wilsonLowerBound(0, 0), 0);
});

test('pickGems keeps 20–20,000 reviews at 80%+ positive, ranked by confidence-adjusted rating', () => {
  const r = (appid, positive, negative) => ({ appid, name: `G${appid}`, positive, negative });
  const list = [
    r(1, 15, 0),        // too few reviews
    r(2, 18, 2),        // 90% of 20 → keep, lowest confidence
    r(3, 25000, 100),   // too many reviews
    r(4, 790, 210),     // 79% → below ratio
    r(5, 1960, 40),     // 98% of 2,000 → keep, ranks first
    r(6, 20, 0),        // 100% of 20 → keep
    r(7, 80, 20),       // exactly 80% of 100 → keep
  ];
  assert.deepEqual(pickGems(list).map(g => g.appid), [5, 6, 7, 2]);
  const many = Array.from({ length: GEMS_PER_TAG + 5 }, (_, i) => r(100 + i, 100, 0));
  assert.equal(pickGems(many).length, GEMS_PER_TAG);
});

test('refresh searches up to TOP_TAGS tags', async () => {
  const seedTags = Object.fromEntries(Array.from({ length: TOP_TAGS + 3 }, (_, i) => [`T${i}`, 100 - i]));
  const { catalog, calls } = setup({ seedTags });
  await catalog.refresh();
  assert.equal(calls.lists.length, 1 + TOP_TAGS);
});

test('hidden gems are fetched before popular picks', async () => {
  const popular = Array.from({ length: 5 }, (_, i) => row(100 + i, 100_000 + i));
  const gem = { appid: 999, name: 'Gem', positive: 300, negative: 10 };
  const { catalog, calls } = setup({ tagLists: { Roguelike: [...popular, gem] }, top2: [row(500, 1)] });
  await catalog.refresh();
  assert.equal(calls.storeDetails[0], 999);
});

test('SteamSpy and store requests run side by side', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = { run: async fn => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise(r => setTimeout(r, 5)); try { return await fn(); } finally { inFlight--; } } };
  const both = { run: slow.run };
  const { catalog } = setup({ tagLists: { Roguelike: [row(10, 1), row(11, 2), row(12, 3)] }, spyThrottle: slow, storeThrottle: both });
  await catalog.refresh();
  assert.equal(maxInFlight, 2);
  assert.equal(catalog.status().done, 1, 'library-rest phase: the unseeded library game');
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
