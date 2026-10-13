import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../lib/app.js';
import { createStore } from '../lib/store.js';
import { SteamError } from '../lib/steam.js';
import { HttpError } from '../lib/http.js';

function setup({ steam = {}, claude = { enabled: false }, catalog = {} } = {}) {
  const store = createStore();
  const deps = {
    store,
    steam: {
      configured: true,
      getOwnedGames: async () => [{ appid: 1, name: 'Hades', hours: 100 }, { appid: 2, name: 'Celeste', hours: 10 }],
      getWishlist: async () => [50],
      searchStore: async () => [{ appid: 7, name: 'Tunic', capsuleUrl: 'c' }],
      ...steam,
    },
    catalog: {
      status: () => ({ running: false, phase: 'idle', done: 0, total: 0, failed: 0, error: null, candidateCount: 0, finishedAt: null, stale: false }),
      refresh: () => Promise.resolve(),
      ensureApp: async appid => { store.upsertApp({ appid, name: `App ${appid}`, tags: { A: 1 } }); return store.getApp(appid); },
      ...catalog,
    },
    claude,
  };
  return { app: createApp(deps), store };
}

test('GET /api/state returns config and data', async () => {
  const { app, store } = setup();
  store.importOwned([{ appid: 1, name: 'Hades', hours: 1 }]);
  store.upsertApp({ appid: 1, name: 'Hades', tags: { A: 1 } });
  const res = await request(app).get('/api/state').expect(200);
  assert.deepEqual(res.body.config, { steamConfigured: true, claudeEnabled: false });
  assert.equal(res.body.library.length, 1);
  assert.equal(res.body.apps[0].appid, 1);
  assert.equal(res.body.settings.hideTriaged, true);
  assert.equal(res.body.claude, null);
});

test('POST /api/import stores library and wishlist', async () => {
  const { app, store } = setup();
  const res = await request(app).post('/api/import').expect(200);
  assert.deepEqual(res.body, { added: 2, updated: 0 });
  assert.equal(store.getLibrary()[0].appid, 1);
  assert.deepEqual(store.getValue('wishlist', []), [50]);
});

test('POST /api/import maps SteamError codes to 400/422', async () => {
  const priv = setup({ steam: { getOwnedGames: async () => { throw new SteamError('private_profile', 'Set Game details to Public'); } } });
  const r1 = await request(priv.app).post('/api/import').expect(422);
  assert.equal(r1.body.error, 'private_profile');
  assert.match(r1.body.message, /Game details/);
  const missing = setup({ steam: { getOwnedGames: async () => { throw new SteamError('missing_config', 'Add keys'); } } });
  await request(missing.app).post('/api/import').expect(400);
});

test('upstream failures return 502 without leaking the key', async () => {
  const { app } = setup({ steam: { getOwnedGames: async () => { throw new HttpError(500, 'https://api/?key=SECRET'); } } });
  const res = await request(app).post('/api/import').expect(502);
  assert.ok(!JSON.stringify(res.body).includes('SECRET'));
});

test('library order, seed/hidden patch, and add at position', async () => {
  const { app, store } = setup();
  store.importOwned([{ appid: 1, name: 'A', hours: 2 }, { appid: 2, name: 'B', hours: 1 }]);
  let res = await request(app).put('/api/library/order').send({ appids: [2, 1] }).expect(200);
  assert.deepEqual(res.body.library.map(g => g.appid), [2, 1]);
  res = await request(app).patch('/api/library/1').send({ seed: false, hidden: true }).expect(200);
  const g1 = res.body.library.find(g => g.appid === 1);
  assert.equal(g1.seed, false);
  assert.equal(g1.hidden, true);
  await request(app).patch('/api/library/999').send({ seed: true }).expect(404);
  res = await request(app).post('/api/library').send({ appid: 9, name: 'Nine', position: 0 }).expect(200);
  assert.equal(res.body.library[0].appid, 9);
  assert.equal(res.body.app.appid, 9);
  await request(app).put('/api/library/order').send({ appids: ['x'] }).expect(400);
});

test('search requires 2+ characters', async () => {
  const { app } = setup();
  await request(app).get('/api/search?q=a').expect(400);
  const res = await request(app).get('/api/search?q=tu').expect(200);
  assert.equal(res.body.results[0].appid, 7);
});

test('triage put/delete and bucket validation', async () => {
  const { app } = setup();
  let res = await request(app).put('/api/triage/5').send({ bucket: 'interested' }).expect(200);
  assert.deepEqual(res.body.triage.map(t => t.bucket), ['interested']);
  await request(app).put('/api/triage/5').send({ bucket: 'maybe' }).expect(400);
  await request(app).put('/api/triage/6').send({ bucket: 'hidden' }).expect(200);
  await request(app).delete('/api/triage/6').expect(200);
  res = await request(app).delete('/api/triage/5').expect(200);
  assert.deepEqual(res.body.triage, []);
});

test('settings validation', async () => {
  const { app } = setup();
  const res = await request(app).put('/api/settings').send({ sliders: { Roguelike: 2 }, filters: { maxPriceCents: 0 } }).expect(200);
  assert.equal(res.body.settings.sliders.Roguelike, 2);
  assert.equal(res.body.settings.filters.maxPriceCents, 0);
  await request(app).put('/api/settings').send({ sliders: { Roguelike: 5 } }).expect(400);
  const ob = await request(app).put('/api/settings').send({ obscurity: -2 }).expect(200);
  assert.equal(ob.body.settings.obscurity, -2);
  await request(app).put('/api/settings').send({ obscurity: 3 }).expect(400);
  await request(app).put('/api/settings').send({ obscurity: 1.5 }).expect(400);
  await request(app).put('/api/settings').send({ filters: { mode: 'mmo' } }).expect(400);
  const en = await request(app).put('/api/settings').send({ filters: { englishOnly: true } }).expect(200);
  assert.equal(en.body.settings.filters.englishOnly, true);
  await request(app).put('/api/settings').send({ filters: { englishOnly: 'yes' } }).expect(400);
  await request(app).put('/api/settings').send({ blockedTags: 'Horror' }).expect(400);
});

test('catalog refresh returns 202, or 409 when already running', async () => {
  const ok = setup();
  await request(ok.app).post('/api/catalog/refresh').expect(202);
  const busy = setup({ catalog: { refresh: () => null } });
  await request(busy.app).post('/api/catalog/refresh').expect(409);
});

test('claude annotate: disabled', async () => {
  const { app } = setup();
  const res = await request(app).post('/api/claude/annotate').send({ appids: [1] }).expect(200);
  assert.deepEqual(res.body, { enabled: false });
});

test('claude annotate: resolves wildcards, skips owned, persists latest', async () => {
  const claude = {
    enabled: true,
    annotate: async input => ({ blurbs: { [input.recs[0].appid]: 'nice' }, wildcards: [{ name: 'Tunic', blurb: 'fox' }, { name: 'Hades', blurb: 'owned' }] }),
  };
  const steam = { searchStore: async term => (term === 'Tunic' ? [{ appid: 7, name: 'Tunic' }] : [{ appid: 1, name: 'Hades' }]) };
  const { app, store } = setup({ claude, steam });
  store.importOwned([{ appid: 1, name: 'Hades', hours: 5 }]);
  store.upsertApp({ appid: 20, name: 'Cand', tags: { A: 1 } });
  const res = await request(app).post('/api/claude/annotate').send({ appids: [20] }).expect(200);
  assert.equal(res.body.enabled, true);
  assert.deepEqual(res.body.wildcards, [{ appid: 7, blurb: 'fox' }]);
  assert.equal(res.body.blurbs[20], 'nice');
  assert.equal(res.body.blurbs[7], 'fox');
  assert.equal(res.body.apps[0].appid, 7);
  const state = await request(app).get('/api/state').expect(200);
  assert.deepEqual(state.body.claude.wildcards, [{ appid: 7, blurb: 'fox' }]);
  assert.ok(state.body.apps.some(a => a.appid === 7));
});

test('claude annotate: errors become a notice, not a failure', async () => {
  const { app } = setup({ claude: { enabled: true, annotate: async () => { throw new Error('timeout'); } } });
  const res = await request(app).post('/api/claude/annotate').send({ appids: [] }).expect(200);
  assert.match(res.body.error, /Claude unavailable: timeout/);
});

test('serves the Sortable vendor file from node_modules', async () => {
  const { app } = setup();
  await request(app).get('/vendor/Sortable.min.js').expect(200);
});
