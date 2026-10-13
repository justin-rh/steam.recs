import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankWeight, playMultiplier, voteShares, tagIdf, buildProfile, RANK_HALF_LIFE } from '../public/profile.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !== ${b}`);
const game = (appid, rank, extra = {}) => ({ appid, name: `G${appid}`, hours: 0, rank, seed: true, hidden: false, ...extra });
const W1 = 0.5 ** (1 / RANK_HALF_LIFE); // weight of the 2nd seed

test('rankWeight: first seed is 1.0 and weight halves every 4 seeds', () => {
  assert.equal(RANK_HALF_LIFE, 4);
  close(rankWeight(0), 1.0);
  close(rankWeight(4), 0.5);
  close(rankWeight(8), 0.25);
});

test('playMultiplier: 1.0 for no hours, 1.25 at max, 1.0 when maxHours is 0', () => {
  close(playMultiplier(0, 100), 1);
  close(playMultiplier(100, 100), 1.25);
  close(playMultiplier(5, 0), 1);
});

test('voteShares normalizes votes and tolerates empty/null', () => {
  assert.deepEqual(voteShares({ A: 3, B: 1 }), { A: 0.75, B: 0.25 });
  assert.deepEqual(voteShares({}), {});
  assert.deepEqual(voteShares(null), {});
});

test('tagIdf: rare tags weigh more than common ones; apps without tags are ignored', () => {
  const apps = [
    ...Array.from({ length: 99 }, (_, i) => ({ appid: i, tags: { Common: 1 } })),
    { appid: 99, tags: { Common: 1, Rare: 1 } },
    { appid: 100, tags: null },
  ];
  const idf = tagIdf(apps);
  close(idf.Common, Math.sqrt(Math.log(101 / 101) + 1));
  close(idf.Rare, Math.sqrt(Math.log(101 / 2) + 1));
  assert.ok(idf.Rare > 2 * idf.Common, 'rare tags still count clearly more');
  assert.ok(idf.Rare < 3 * idf.Common, 'but the boost is dampened');
});

test('buildProfile weights tags by seed rank and normalizes max to 1', () => {
  const library = [game(1, 0), game(2, 1)];
  const apps = new Map([[1, { tags: { Roguelike: 3, Action: 1 } }], [2, { tags: { Puzzle: 1 } }]]);
  const p = buildProfile(library, apps);
  close(p.affinity.Puzzle, 1);
  close(p.affinity.Roguelike, 0.75 / W1);
  close(p.affinity.Action, 0.25 / W1);
  assert.deepEqual(p.topTags, ['Puzzle', 'Roguelike', 'Action']);
  assert.equal(p.sources.Roguelike[0].appid, 1);
  assert.equal(p.sources.Roguelike[0].rank, 1);
  assert.deepEqual(p.seeds.map(s => s.appid), [1, 2]);
});

test('buildProfile: rank weight counts seeds only, while the displayed rank is the library position', () => {
  const library = [game(1, 0, { seed: false }), game(2, 1)];
  const apps = new Map([[1, { tags: { A: 1 } }], [2, { tags: { B: 1 } }]]);
  const p = buildProfile(library, apps);
  assert.equal(p.affinity.A, undefined);
  close(p.affinity.B, 1);
  assert.equal(p.seeds[0].rank, 2);
  close(p.seeds[0].weight, 1.0);
});

test('buildProfile skips hidden games when assigning the displayed rank', () => {
  const library = [game(1, 0, { hidden: true }), game(2, 1), game(3, 2)];
  const apps = new Map([[2, { tags: { A: 1 } }], [3, { tags: { B: 1 } }]]);
  const p = buildProfile(library, apps);
  assert.equal(p.sources.A[0].rank, 1);
  close(p.seeds[0].weight, 1.0);
});

test('buildProfile sorts library by rank regardless of input order', () => {
  const library = [game(2, 1), game(1, 0)];
  const apps = new Map([[1, { tags: { A: 1 } }], [2, { tags: { B: 1 } }]]);
  assert.equal(buildProfile(library, apps).topTags[0], 'A');
});

test('buildProfile: games without tag data contribute nothing and do not produce NaN', () => {
  const library = [game(1, 0), game(2, 1)];
  const apps = new Map([[1, { tags: {} }]]);
  const p = buildProfile(library, apps);
  assert.deepEqual(p.affinity, {});
  assert.deepEqual(p.topTags, []);
});

test('buildProfile: playtime multiplies the rank weight by up to 1.25', () => {
  const library = [game(1, 0, { hours: 100 }), game(2, 1, { hours: 0 })];
  const apps = new Map([[1, { tags: { A: 1 } }], [2, { tags: { B: 1 } }]]);
  const p = buildProfile(library, apps);
  close(p.seeds[0].weight, 1.25);
  close(p.affinity.B, W1 / 1.25);
});

test('buildProfile: heavy playtime cannot lift a 10th-ranked seed past #1', () => {
  const library = [game(1, 0, { hours: 0 }), ...Array.from({ length: 8 }, (_, i) => game(10 + i, i + 1)), game(2, 9, { hours: 5000 })];
  const apps = new Map([[1, { tags: { X: 1 } }], [2, { tags: { Y: 1 } }]]);
  const p = buildProfile(library, apps);
  assert.ok(p.affinity.X > p.affinity.Y);
});

test('buildProfile: a rare tag only a 10th-ranked seed has cannot outrank the main tag of the #1 seed', () => {
  const library = Array.from({ length: 10 }, (_, i) => game(i + 1, i));
  const apps = new Map([[1, { tags: { Exploration: 1 } }], [10, { tags: { Clicker: 1 } }]]);
  const catalog = [
    ...Array.from({ length: 50 }, (_, i) => ({ tags: { Exploration: 1 } })),
    ...Array.from({ length: 49 }, (_, i) => ({ tags: { Other: 1 } })),
    { tags: { Clicker: 1 } },
  ];
  const p = buildProfile(library, apps, { idf: tagIdf(catalog) });
  assert.equal(p.topTags[0], 'Exploration');
});

test('buildProfile: IDF lowers generic tags relative to distinctive ones', () => {
  const library = [game(1, 0)];
  const apps = new Map([[1, { tags: { Generic: 1, Distinctive: 1 } }]]);
  const p = buildProfile(library, apps, { idf: { Generic: 1, Distinctive: 5 } });
  close(p.affinity.Distinctive, 1);
  close(p.affinity.Generic, 0.2);
});

test('buildProfile: each source carries its fraction of the tag', () => {
  const library = [game(1, 0), game(2, 1)];
  const apps = new Map([[1, { tags: { T: 1 } }], [2, { tags: { T: 1 } }]]);
  const p = buildProfile(library, apps);
  close(p.sources.T[0].frac, 1 / (1 + W1));
  close(p.sources.T[1].frac, W1 / (1 + W1));
});
