import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';

const owned = n => Array.from({ length: n }, (_, i) => ({ appid: i + 1, name: `Game ${i + 1}`, hours: i }));

test('first import ranks by hours desc and seeds the top 10', () => {
  const s = createStore();
  assert.deepEqual(s.importOwned(owned(12)), { added: 12, updated: 0 });
  const lib = s.getLibrary();
  assert.equal(lib[0].appid, 12);
  assert.equal(lib[0].rank, 0);
  assert.equal(lib.filter(g => g.seed).length, 10);
  assert.equal(lib[11].seed, false);
  assert.equal(lib[0].source, 'steam');
});

test('re-import keeps ranks, updates hours, appends new games unseeded', () => {
  const s = createStore();
  s.importOwned(owned(3));
  s.reorder([1, 2, 3]);
  const result = s.importOwned([{ appid: 1, name: 'Game 1', hours: 50 }, { appid: 99, name: 'New', hours: 999 }]);
  assert.deepEqual(result, { added: 1, updated: 1 });
  const lib = s.getLibrary();
  assert.deepEqual(lib.map(g => g.appid), [1, 2, 3, 99]);
  assert.equal(lib[0].hours, 50);
  assert.equal(lib[3].seed, false);
});

test('manual games before first Steam import do not block default seeding', () => {
  const s = createStore();
  s.addGame({ appid: 500, name: 'Manual' });
  s.importOwned(owned(2));
  assert.equal(s.getLibrary().filter(g => g.source === 'steam' && g.seed).length, 2);
});

test('addGame inserts at position, seeds, and un-hides existing', () => {
  const s = createStore();
  s.importOwned(owned(3));
  s.addGame({ appid: 77, name: 'Inserted', position: 1 });
  assert.deepEqual(s.getLibrary().map(g => g.appid), [3, 77, 2, 1]);
  assert.equal(s.getLibrary()[1].seed, true);
  s.setHidden(2, true);
  s.addGame({ appid: 2, name: 'Game 2', position: 0 });
  const lib = s.getLibrary();
  assert.equal(lib[0].appid, 2);
  assert.equal(lib[0].hidden, false);
});

test('reorder puts unlisted games after listed ones', () => {
  const s = createStore();
  s.importOwned(owned(4));
  s.reorder([1, 2]);
  assert.deepEqual(s.getLibrary().map(g => g.appid), [1, 2, 4, 3]);
});

test('setSeed/setHidden return false for unknown appid', () => {
  const s = createStore();
  s.importOwned(owned(1));
  assert.equal(s.setSeed(1, false), true);
  assert.equal(s.getLibrary()[0].seed, false);
  assert.equal(s.setSeed(42, true), false);
  assert.equal(s.setHidden(42, true), false);
});

test('upsertApp merges patches and round-trips JSON fields', () => {
  const s = createStore();
  s.upsertApp({ appid: 10, name: 'X', tags: { A: 5 }, priceCents: 999, reviewPct: 0.8, reviewCount: 100, tagsAt: 1 });
  s.upsertApp({ appid: 10, releaseYear: 2021, modes: ['single', 'coop'], deckVerified: true, detailsAt: 2 });
  const a = s.getApp(10);
  assert.deepEqual(a.tags, { A: 5 });
  assert.deepEqual(a.modes, ['single', 'coop']);
  assert.equal(a.priceCents, 999);
  assert.equal(a.deckVerified, true);
  assert.equal(a.tagsAt, 1);
  assert.equal(a.detailsAt, 2);
  assert.equal(s.getApp(11), null);
  assert.deepEqual(s.getApps([10, 11]).map(x => x.appid), [10]);
  assert.deepEqual(s.getApps([]), []);
});

test('triage set/clear and bucket validation', () => {
  const s = createStore();
  s.setTriage(5, 'interested');
  s.setTriage(5, 'not_for_me');
  assert.deepEqual(s.getTriage().map(t => [t.appid, t.bucket]), [[5, 'not_for_me']]);
  assert.throws(() => s.setTriage(5, 'maybe'), RangeError);
  s.setTriage(6, 'hidden');
  assert.equal(s.getTriage().find(t => t.appid === 6).bucket, 'hidden');
  s.clearTriage(6);
  s.clearTriage(5);
  assert.deepEqual(s.getTriage(), []);
});

test('settings merge with defaults and ignore unknown keys', () => {
  const s = createStore();
  assert.equal(s.getSettings().hideTriaged, true);
  const out = s.patchSettings({ sliders: { Roguelike: 2 }, filters: { deckOnly: true }, bogus: 1 });
  assert.equal(out.sliders.Roguelike, 2);
  assert.equal(out.filters.deckOnly, true);
  assert.equal(out.filters.mode, 'any');
  assert.equal(s.getSettings().bogus, undefined);
});

test('getValue/setValue store arbitrary JSON', () => {
  const s = createStore();
  assert.deepEqual(s.getValue('candidateIds', []), []);
  s.setValue('candidateIds', [1, 2]);
  assert.deepEqual(s.getValue('candidateIds', []), [1, 2]);
});
