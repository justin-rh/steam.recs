import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankWeight, playBonus, voteShares, buildProfile } from '../public/profile.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !== ${b}`);
const game = (appid, rank, extra = {}) => ({ appid, name: `G${appid}`, hours: 0, rank, seed: true, hidden: false, ...extra });

test('rankWeight: #1 is 1.0, last is 0.2, single game is 1.0', () => {
  close(rankWeight(0, 5), 1.0);
  close(rankWeight(4, 5), 0.2);
  close(rankWeight(2, 5), 0.6);
  close(rankWeight(0, 1), 1.0);
});

test('playBonus: 0 for no hours, 0.25 at max, 0 when maxHours is 0', () => {
  close(playBonus(0, 100), 0);
  close(playBonus(100, 100), 0.25);
  close(playBonus(5, 0), 0);
});

test('voteShares normalizes votes and tolerates empty/null', () => {
  assert.deepEqual(voteShares({ A: 3, B: 1 }), { A: 0.75, B: 0.25 });
  assert.deepEqual(voteShares({}), {});
  assert.deepEqual(voteShares(null), {});
});

test('buildProfile weights tags by rank and normalizes max to 1', () => {
  const library = [game(1, 0), game(2, 1)];
  const apps = new Map([[1, { tags: { Roguelike: 3, Action: 1 } }], [2, { tags: { Puzzle: 1 } }]]);
  const p = buildProfile(library, apps);
  close(p.affinity.Roguelike, 1);
  close(p.affinity.Action, 1 / 3);
  close(p.affinity.Puzzle, 0.2 / 0.75);
  assert.deepEqual(p.topTags, ['Roguelike', 'Action', 'Puzzle']);
  assert.equal(p.sources.Roguelike[0].appid, 1);
  assert.equal(p.sources.Roguelike[0].rank, 1);
  assert.deepEqual(p.seeds.map(s => s.appid), [1, 2]);
});

test('buildProfile ignores unseeded games but they still occupy a rank', () => {
  const library = [game(1, 0, { seed: false }), game(2, 1)];
  const apps = new Map([[1, { tags: { A: 1 } }], [2, { tags: { B: 1 } }]]);
  const p = buildProfile(library, apps);
  assert.equal(p.affinity.A, undefined);
  close(p.affinity.B, 1);
  assert.equal(p.seeds[0].rank, 2);
  close(p.seeds[0].weight, 0.2);
});

test('buildProfile skips hidden games when assigning rank', () => {
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

test('buildProfile: playtime bonus is added to rank weight', () => {
  const library = [game(1, 0, { hours: 100 }), game(2, 1, { hours: 0 })];
  const apps = new Map([[1, { tags: { A: 1 } }], [2, { tags: { B: 1 } }]]);
  const p = buildProfile(library, apps);
  close(p.seeds[0].weight, 1.25);
  close(p.affinity.B, 0.2 / 1.25);
});
