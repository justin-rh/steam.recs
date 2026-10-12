import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile } from '../public/profile.js';
import {
  DEFAULT_SETTINGS, mergeSettings, excludeReason, triageAdjustments, scoreApp, scaleLines, scoreCandidates,
} from '../public/score.js';

const app = (appid, tags, extra = {}) => ({
  appid, name: `App ${appid}`, tags, developer: 'Dev Co', publisher: 'Pub Co', priceCents: 1999,
  reviewPct: 0.9, reviewCount: 5000, releaseYear: 2020, deckVerified: true, modes: ['single'], capsuleUrl: null, ...extra,
});
const ctx = (extra = {}) => ({ excludeIds: new Set(), wishlistIds: new Set(), triagedIds: new Set(), ...extra });
const lib = [{ appid: 100, name: 'Hades', hours: 0, rank: 0, seed: true, hidden: false }];
const libApps = new Map([[100, { tags: { Roguelike: 3, Action: 1 } }]]);
const profile = buildProfile(lib, libApps);
const noAdj = { up: {}, down: {} };

test('mergeSettings deep-merges filters and keeps defaults', () => {
  const s = mergeSettings({ filters: { deckOnly: true } });
  assert.equal(s.filters.deckOnly, true);
  assert.equal(s.filters.mode, 'any');
  assert.equal(s.hideTriaged, true);
  assert.notEqual(s.sliders, DEFAULT_SETTINGS.sliders);
});

test('excludeReason: owned, triaged, wishlisted', () => {
  const s = mergeSettings({ hideWishlisted: true });
  assert.equal(excludeReason(app(1, { A: 1 }), s, ctx({ excludeIds: new Set([1]) })), 'owned');
  assert.equal(excludeReason(app(1, { A: 1 }), s, ctx({ triagedIds: new Set([1]) })), 'triaged');
  assert.equal(excludeReason(app(1, { A: 1 }), s, ctx({ wishlistIds: new Set([1]) })), 'wishlisted');
  assert.equal(excludeReason(app(1, { A: 1 }), mergeSettings({ hideTriaged: false }), ctx({ triagedIds: new Set([1]) })), null);
});

test('excludeReason: blocked tag and company are case-insensitive; companies split on commas', () => {
  assert.equal(excludeReason(app(1, { Horror: 1 }), mergeSettings({ blockedTags: ['horror'] }), ctx()), 'blocked-tag');
  const multi = app(1, { A: 1 }, { developer: 'Alpha, Beta Studios' });
  assert.equal(excludeReason(multi, mergeSettings({ blockedCompanies: ['beta studios'] }), ctx()), 'blocked-company');
});

test('excludeReason: filters, including 0 meaning free-only and null fields failing active filters', () => {
  const f = filters => mergeSettings({ filters });
  assert.equal(excludeReason(app(1, { A: 1 }), f({ maxPriceCents: 0 }), ctx()), 'price');
  assert.equal(excludeReason(app(1, { A: 1 }, { priceCents: 0 }), f({ maxPriceCents: 0 }), ctx()), null);
  assert.equal(excludeReason(app(1, { A: 1 }), f({ maxPriceCents: null }), ctx()), null);
  assert.equal(excludeReason(app(1, { A: 1 }), f({ minReviewPct: 0.95 }), ctx()), 'review-pct');
  assert.equal(excludeReason(app(1, { A: 1 }), f({ minReviewCount: 10000 }), ctx()), 'review-count');
  assert.equal(excludeReason(app(1, { A: 1 }), f({ yearMin: 2021 }), ctx()), 'year');
  assert.equal(excludeReason(app(1, { A: 1 }), f({ yearMax: 2019 }), ctx()), 'year');
  assert.equal(excludeReason(app(1, { A: 1 }, { releaseYear: null }), f({ yearMin: 2000 }), ctx()), 'year');
  assert.equal(excludeReason(app(1, { A: 1 }, { deckVerified: null }), f({ deckOnly: true }), ctx()), 'deck');
  assert.equal(excludeReason(app(1, { A: 1 }), f({ mode: 'coop' }), ctx()), 'mode');
  assert.equal(excludeReason(app(1, { A: 1 }, { modes: null }), f({ mode: 'any' }), ctx()), null);
});

test('triageAdjustments splits interested and not-for-me by vote share; played is ignored', () => {
  const adj = triageAdjustments([
    { appid: 1, bucket: 'interested', tags: { A: 1, B: 1 } },
    { appid: 2, bucket: 'not_for_me', tags: { C: 1 } },
    { appid: 3, bucket: 'played', tags: { D: 1 } },
    { appid: 4, bucket: 'interested', tags: undefined },
  ]);
  assert.deepEqual(adj, { up: { A: 0.5, B: 0.5 }, down: { C: 1 } });
});

test('scoreApp: seed overlap is grouped by the dominant seed game', () => {
  const s = mergeSettings();
  const { lines } = scoreApp(app(1, { Roguelike: 1 }, { reviewPct: null }), profile, s, noAdj);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].label, 'Hades (#1) overlap');
  assert.equal(lines[0].kind, 'seed');
  assert.ok(Math.abs(lines[0].value - 1) < 1e-9);
});

test('scoreApp: slider boost/suppress lines use v * 0.15 * share', () => {
  const s = mergeSettings({ sliders: { Puzzle: 2, Horror: -1 } });
  const { lines } = scoreApp(app(1, { Puzzle: 1, Horror: 1 }, { reviewPct: null }), profile, s, noAdj);
  const boost = lines.find(l => l.label === 'Puzzle boost');
  const supp = lines.find(l => l.label === 'Horror suppress');
  assert.ok(Math.abs(boost.value - 0.15) < 1e-9);
  assert.ok(Math.abs(supp.value + 0.075) < 1e-9);
});

test('scoreApp: triage feedback lines and quality nudge', () => {
  const s = mergeSettings();
  const adj = { up: { A: 1 }, down: { B: 1 } };
  const { lines, raw } = scoreApp(app(1, { A: 1, B: 1 }, { reviewPct: 0.9 }), profile, s, adj);
  const up = lines.find(l => l.label === 'Similar to games you marked Interested');
  const down = lines.find(l => l.label === 'Similar to games you marked Not for me');
  const q = lines.find(l => l.label === 'Review score');
  assert.ok(Math.abs(up.value - 0.025) < 1e-9);
  assert.ok(Math.abs(down.value + 0.025) < 1e-9);
  assert.ok(Math.abs(q.value - 0.02) < 1e-9);
  assert.ok(Math.abs(raw - 0.02) < 1e-9);
});

test('scoreApp: quality nudge is skipped below the minimum review count', () => {
  const s = mergeSettings({ filters: { minReviewCount: 10000 } });
  const { lines } = scoreApp(app(1, { A: 1 }, { reviewCount: 50 }), profile, s, noAdj);
  assert.equal(lines.find(l => l.kind === 'quality'), undefined);
});

test('scaleLines: integer lines always sum to the target', () => {
  const lines = [{ label: 'a', kind: 'seed', value: 0.333 }, { label: 'b', kind: 'seed', value: 0.333 }, { label: 'c', kind: 'seed', value: 0.334 }];
  const scaled = scaleLines(lines, 100, 100);
  assert.equal(scaled.reduce((s, l) => s + l.value, 0), 100);
  assert.ok(scaled.every(l => Number.isInteger(l.value)));
});

test('scoreCandidates: sorts, normalizes top to 100, counts unscored, excludes owned', () => {
  const candidates = [
    app(1, { Roguelike: 1 }),
    app(2, { Action: 1 }),
    app(3, {}),
    app(4, null),
    app(5, { Roguelike: 1 }),
  ];
  const r = scoreCandidates({
    profile, candidates, settings: mergeSettings(),
    ctx: { excludeIds: new Set([5]), wishlistIds: new Set(), triage: [] },
  });
  assert.deepEqual(r.recs.map(x => x.appid), [1, 2]);
  assert.equal(r.recs[0].score, 100);
  assert.equal(r.unscored, 2);
  assert.equal(r.eligible, 2);
});

test('scoreCandidates: breakdown lines sum exactly to the displayed score for every rec', () => {
  const candidates = Array.from({ length: 50 }, (_, i) =>
    app(i + 1, { Roguelike: (i % 7) + 1, Action: (i % 3) + 1, Puzzle: (i % 5), Horror: i % 2 }, { reviewPct: 0.5 + (i % 10) / 20 }));
  const settings = mergeSettings({ sliders: { Puzzle: 1, Horror: -2 } });
  const triage = [{ appid: 999, bucket: 'not_for_me', tags: { Action: 1 } }, { appid: 998, bucket: 'interested', tags: { Puzzle: 1 } }];
  const r = scoreCandidates({ profile, candidates, settings, ctx: { excludeIds: new Set(), wishlistIds: new Set(), triage } });
  assert.equal(r.recs.length, 30);
  for (const rec of r.recs) {
    assert.equal(rec.lines.reduce((s, l) => s + l.value, 0), rec.score, `appid ${rec.appid}`);
  }
});

test('scoreCandidates: pinned ids are kept even when outside the limit', () => {
  const candidates = [app(1, { Roguelike: 1 }), app(2, { Roguelike: 1 }), app(3, { Zzz: 1 }, { reviewPct: 0.1 })];
  const r = scoreCandidates({
    profile, candidates, settings: mergeSettings(), limit: 1, pinnedIds: new Set([3]),
    ctx: { excludeIds: new Set(), wishlistIds: new Set(), triage: [] },
  });
  assert.deepEqual(r.recs.map(x => x.appid), [1, 3]);
  assert.equal(r.recs[1].pinned, true);
});

test('scoreCandidates: empty profile yields finite scores with no NaN', () => {
  const empty = buildProfile([], new Map());
  const r = scoreCandidates({
    profile: empty, candidates: [app(1, { A: 1 }, { reviewPct: null }), app(2, { B: 1 })], settings: mergeSettings(),
    ctx: { excludeIds: new Set(), wishlistIds: new Set(), triage: [] },
  });
  for (const rec of r.recs) {
    assert.ok(Number.isFinite(rec.score));
    assert.equal(rec.lines.reduce((s, l) => s + l.value, 0), rec.score);
  }
});
