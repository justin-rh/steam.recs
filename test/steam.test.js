import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSteamClient, SteamError, capsuleFor } from '../lib/steam.js';

function routeFetch(routes) {
  const calls = [];
  const fetch = async url => {
    calls.push(url);
    const hit = Object.entries(routes).find(([frag]) => url.includes(frag));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit[1] };
  };
  return { fetch, calls };
}

test('missing config throws SteamError missing_config', async () => {
  const c = createSteamClient({ apiKey: '', steamId: '', fetch: async () => { throw new Error('no'); } });
  assert.equal(c.configured, false);
  await assert.rejects(c.getOwnedGames(), err => err instanceof SteamError && err.code === 'missing_config');
});

test('17-digit SteamID is used directly; vanity names are resolved once', async () => {
  const direct = createSteamClient({ apiKey: 'k', steamId: '76561198000000001', fetch: async () => { throw new Error('no fetch'); } });
  assert.equal(await direct.resolveSteamId(), '76561198000000001');

  const { fetch, calls } = routeFetch({ ResolveVanityURL: { response: { success: 1, steamid: '76561198000000002' } } });
  const vanity = createSteamClient({ apiKey: 'k', steamId: 'gaben', fetch });
  assert.equal(await vanity.resolveSteamId(), '76561198000000002');
  await vanity.resolveSteamId();
  assert.equal(calls.length, 1);
});

test('unresolvable vanity throws vanity_not_found', async () => {
  const { fetch } = routeFetch({ ResolveVanityURL: { response: { success: 42 } } });
  const c = createSteamClient({ apiKey: 'k', steamId: 'nobody', fetch });
  await assert.rejects(c.resolveSteamId(), err => err.code === 'vanity_not_found');
});

test('getOwnedGames maps playtime minutes to hours', async () => {
  const { fetch } = routeFetch({ GetOwnedGames: { response: { game_count: 1, games: [{ appid: 1145360, name: 'Hades', playtime_forever: 8430 }] } } });
  const c = createSteamClient({ apiKey: 'k', steamId: '76561198000000001', fetch });
  assert.deepEqual(await c.getOwnedGames(), [{ appid: 1145360, name: 'Hades', hours: 140.5 }]);
});

test('empty owned-games response is reported as a private profile', async () => {
  const { fetch } = routeFetch({ GetOwnedGames: { response: {} } });
  const c = createSteamClient({ apiKey: 'k', steamId: '76561198000000001', fetch });
  await assert.rejects(c.getOwnedGames(), err => err.code === 'private_profile' && /Game details/.test(err.message));
});

test('getWishlist returns appids, and [] on failure', async () => {
  const { fetch } = routeFetch({ GetWishlist: { response: { items: [{ appid: 10 }, { appid: 20 }] } } });
  assert.deepEqual(await createSteamClient({ apiKey: 'k', steamId: '76561198000000001', fetch }).getWishlist(), [10, 20]);
  const failing = createSteamClient({ apiKey: 'k', steamId: '76561198000000001', fetch: async () => { throw new TypeError('down'); } });
  assert.deepEqual(await failing.getWishlist(), []);
});

test('searchStore keeps apps only', async () => {
  const { fetch } = routeFetch({ storesearch: { total: 2, items: [{ type: 'app', id: 1, name: 'Hades', tiny_image: 'img' }, { type: 'sub', id: 2, name: 'Bundle' }] } });
  const c = createSteamClient({ apiKey: 'k', steamId: '76561198000000001', fetch });
  assert.deepEqual(await c.searchStore('hades'), [{ appid: 1, name: 'Hades', capsuleUrl: 'img' }]);
});

test('getAppDetails parses year, modes, price; null when unsuccessful', async () => {
  const { fetch } = routeFetch({
    'appids=10': { 10: { success: true, data: {
      name: 'Ten', is_free: false, price_overview: { final: 1499 }, release_date: { date: '6 Aug, 2018' },
      categories: [{ id: 2 }, { id: 38 }, { id: 36 }, { id: 22 }], capsule_image: 'cap',
    } } },
    'appids=11': { 11: { success: false } },
    'appids=12': { 12: { success: true, data: { name: 'Free', is_free: true, release_date: { date: 'Coming soon' } } } },
  });
  const c = createSteamClient({ apiKey: 'k', steamId: '76561198000000001', fetch });
  assert.deepEqual(await c.getAppDetails(10), { name: 'Ten', releaseYear: 2018, modes: ['single', 'coop', 'multi'], priceCents: 1499, capsuleUrl: 'cap' });
  assert.equal(await c.getAppDetails(11), null);
  const free = await c.getAppDetails(12);
  assert.equal(free.priceCents, 0);
  assert.equal(free.releaseYear, null);
  assert.equal(free.capsuleUrl, capsuleFor(12));
});

test('getDeckVerified: category 3 is verified, others false, missing null', async () => {
  const { fetch } = routeFetch({
    'nAppID=1&': { success: 1, results: { resolved_category: 3 } },
    'nAppID=2&': { success: 1, results: { resolved_category: 2 } },
    'nAppID=3&': { success: 1, results: {} },
  });
  const c = createSteamClient({ apiKey: 'k', steamId: '76561198000000001', fetch });
  assert.equal(await c.getDeckVerified(1), true);
  assert.equal(await c.getDeckVerified(2), false);
  assert.equal(await c.getDeckVerified(3), null);
});
