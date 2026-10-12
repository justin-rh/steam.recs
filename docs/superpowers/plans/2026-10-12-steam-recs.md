# Steam Recs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local three-panel web app that recommends unplayed Steam games from a drag-ranked library, with tunable tags/filters/exclusions, drag-and-drop triage, an itemized score breakdown per card, and optional Claude blurbs + wildcard picks.

**Architecture:** An Express server (`server.js` → `lib/app.js`) owns all external I/O: the Steam Web API, the Steam store, SteamSpy, Claude, and SQLite. Scoring is pure ES modules (`public/profile.js`, `public/score.js`) that run in the browser for instant re-scoring and in Node for tests. The catalog of candidate games is built in the background through per-host throttled queues and cached in SQLite for 7 days.

**Tech Stack:** Node 24 (ESM, `node --test`, `--env-file-if-exists`), Express 5, better-sqlite3, SortableJS, `@anthropic-ai/sdk`, supertest (dev). Vanilla JS/HTML/CSS frontend, with no build step.

**Spec:** `docs/superpowers/specs/2026-10-12-steam-recs-design.md`

## Global Constraints

- All code is ES modules (`"type": "module"`). No TypeScript, no bundler, no frontend framework.
- `public/profile.js`, `public/score.js`, `public/format.js`, `public/ui/tune-form.js` must not touch `window`/`document` at import time, because Node tests import them.
- Scoring constants are copied verbatim from the spec:
  - Rank weight: `1.0 - 0.8 * i / max(n-1, 1)`.
  - Playtime bonus: `0.25 * log10(1+hours) / log10(1+maxHours)`.
  - Slider: `v * 0.15 * share`, with `v` from −2 to +2.
  - Triage: ±`0.05` per tag share.
  - Quality: `0.1 * (reviewPct - 0.7)`.
  - Display: `round(100 * raw / maxRawInSet)`.
- Breakdown lines must sum exactly to the displayed score.
- Defaults: top 10 library games seeded on first Steam import; sliders 0; `hideTriaged` on; `hideWishlisted` off; owned and library games are always hidden from recs.
- Catalog freshness is 7 days. SteamSpy calls are spaced ≥ 1100 ms apart, store calls ≥ 1500 ms. Retries: 3, on 429, 5xx, or network/JSON errors.
- The candidate pool is the top-100-in-2-weeks list plus the 40 games with the most positive reviews from each of the profile's top 8 tags, minus the library.
- Claude: model `claude-opus-5-5`, effort `low`, `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`, 60 s timeout, 1 retry, max 3 wildcards. Claude is called only on Regenerate.
- API keys never reach the browser, and never appear in error messages (redact `key=`).
- The server listens on `127.0.0.1`, `PORT` default 3000. The DB file is `steam-recs.db` (gitignored).
- Commit after every task with a conventional-commit message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A game with no tag data.** Example: SteamSpy returns `"tags": []` for a new or delisted app, or nothing for an app ID. Expected: the profile ignores it, scoring counts it as "unscored", and nothing crashes or produces `NaN`. Pinned by tests in Tasks 1, 2, 5.
2. **Nothing seeded, or an empty library.** Expected: every score is a finite number (no `NaN`/`Infinity`), the recs still sort, and every card's breakdown still sums to its score. Pinned by tests in Task 2.
3. **An upstream service returns a 429, an HTML error page, or a timeout in the middle of a build.** Expected: the call retries with backoff. If it still fails, that one app is counted as failed and the build continues. If the candidate lists themselves fail, the previously cached candidates are used. Pinned by tests in Tasks 3 and 6.
4. **Game names or tags containing `<`, `&`, `"`, or `'`** (e.g. `Baldur's Gate 3`, `Tom Clancy's`). Expected: they render as text, never as HTML, including inside `data-` attributes. Pinned by tests in Task 9.
5. **A blank filter field versus `0`.** A blank max price means no limit; `0` means free games only. A blank minimum review % means no minimum. Pinned by tests in Task 9 (`readFilters`) and Task 2 (`excludeReason`).

---

## File Map

| File | Responsibility |
|---|---|
| `package.json` | Scripts and dependencies |
| `server.js` | Wire real dependencies from env, listen on 127.0.0.1 |
| `lib/app.js` | `createApp(deps)`: Express routes and validation |
| `lib/http.js` | `fetchJson`, `HttpError`, `isRetryable`, key redaction |
| `lib/throttle.js` | `createThrottle`: serialized, spaced calls with retry/backoff |
| `lib/store.js` | `createStore`: SQLite schema and all data access |
| `lib/steam.js` | `createSteamClient`: Web API + store endpoints |
| `lib/steamspy.js` | `createSteamSpyClient`: tags, review counts, lists |
| `lib/catalog.js` | `createCatalog`: background candidate-pool build and status |
| `lib/claude.js` | `createClaudeClient`, `buildPrompt`, `resolveWildcards` |
| `public/profile.js` | Pure: rank/playtime weights → tag-affinity profile |
| `public/score.js` | Pure: excludes, scoring, breakdown scaling |
| `public/format.js` | Pure: escaping and display formatting |
| `public/ui/tune-form.js` | Pure: filter form ↔ settings conversion |
| `public/ui/library.js`, `recs.js`, `tune.js` | Panel renderers (DOM) |
| `public/api.js` | Browser fetch wrapper |
| `public/app.js` | Browser state, actions, Sortable wiring |
| `public/index.html`, `style.css` | Cockpit markup and styling |
| `test/*.test.js` | `node --test` suites |

---

### Task 1: Project scaffold + profile model

**Files:**
- Create: `package.json`, `public/profile.js`, `test/profile.test.js`

**Interfaces:**
- Produces:
  - `rankWeight(index: number, count: number): number`
  - `playBonus(hours: number, maxHours: number): number`
  - `voteShares(tags: Record<string, number> | null): Record<string, number>`
  - `buildProfile(library: LibraryGame[], appsById: Map<number, {tags}>): Profile`, where:
    - `LibraryGame = {appid, name, hours, rank, seed: boolean, hidden: boolean}`
    - `Profile = {affinity: Record<tag, 0..1>, sources: Record<tag, {appid, name, rank, contribution}[]>, topTags: string[], seeds: {appid, name, rank, weight}[]}`
    - `rank` in `sources`/`seeds` is the 1-based position among visible (non-hidden) games.

- [ ] **Step 1: Create package.json and install**

```json
{
  "name": "steam-recs",
  "version": "0.1.0",
  "private": true,
  "description": "Customizable Steam game recommender",
  "type": "module",
  "scripts": {
    "start": "node --env-file-if-exists=.env server.js",
    "test": "node --test"
  }
}
```

Run: `npm install express@5 better-sqlite3@13 sortablejs@1 @anthropic-ai/sdk && npm install -D supertest@7`
Expected: installs without node-gyp errors (better-sqlite3 ships Windows prebuilds for Node 24). If a native build error appears, stop and report it; do not switch libraries.

- [ ] **Step 2: Write the failing tests**

`test/profile.test.js`:

```js
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
  assert.deepEqual(p.topTags, ['Roguelike', 'Puzzle', 'Action']);
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/profile.test.js`
Expected: FAIL with `Cannot find module ... public/profile.js`

- [ ] **Step 4: Implement `public/profile.js`**

```js
// Pure module: shared by the browser and Node tests. No DOM access.
export const RANK_TOP = 1.0;
export const RANK_BOTTOM = 0.2;
export const PLAY_BONUS_MAX = 0.25;

export function rankWeight(index, count) {
  return RANK_TOP - (RANK_TOP - RANK_BOTTOM) * index / Math.max(count - 1, 1);
}

export function playBonus(hours, maxHours) {
  if (!maxHours || maxHours <= 0) return 0;
  return PLAY_BONUS_MAX * Math.log10(1 + hours) / Math.log10(1 + maxHours);
}

export function voteShares(tags) {
  const entries = Object.entries(tags || {}).filter(([, v]) => Number(v) > 0);
  const total = entries.reduce((sum, [, v]) => sum + Number(v), 0);
  if (total <= 0) return {};
  return Object.fromEntries(entries.map(([tag, v]) => [tag, Number(v) / total]));
}

export function buildProfile(library, appsById) {
  const visible = library.filter(g => !g.hidden).sort((a, b) => a.rank - b.rank);
  const n = visible.length;
  const maxHours = Math.max(0, ...visible.map(g => g.hours || 0));
  const raw = {};
  const sources = {};
  const seeds = [];

  visible.forEach((g, i) => {
    if (!g.seed) return;
    const rank = i + 1;
    const weight = rankWeight(i, n) + playBonus(g.hours || 0, maxHours);
    seeds.push({ appid: g.appid, name: g.name, rank, weight });
    for (const [tag, share] of Object.entries(voteShares(appsById.get(g.appid)?.tags))) {
      const contribution = weight * share;
      raw[tag] = (raw[tag] || 0) + contribution;
      (sources[tag] ||= []).push({ appid: g.appid, name: g.name, rank, contribution });
    }
  });

  const max = Math.max(0, ...Object.values(raw));
  const affinity = {};
  for (const [tag, v] of Object.entries(raw)) affinity[tag] = max > 0 ? v / max : 0;
  for (const list of Object.values(sources)) list.sort((a, b) => b.contribution - a.contribution);
  const topTags = Object.keys(affinity).sort((a, b) => affinity[b] - affinity[a] || a.localeCompare(b));
  return { affinity, sources, topTags, seeds };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/profile.test.js`
Expected: PASS (9 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json public/profile.js test/profile.test.js
git commit -m "feat: scaffold project and add tag-affinity profile model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Scoring engine

**Files:**
- Create: `public/score.js`, `test/score.test.js`

**Interfaces:**
- Consumes: `voteShares` from `public/profile.js`; `Profile` shape from Task 1.
- Produces:
  - `DEFAULT_SETTINGS`: `{sliders: {}, blockedTags: [], blockedCompanies: [], filters: {maxPriceCents: null, minReviewPct: null, minReviewCount: null, yearMin: null, yearMax: null, deckOnly: false, mode: 'any'}, hideWishlisted: false, hideTriaged: true}`
  - `SETTING_KEYS`: `['sliders','blockedTags','blockedCompanies','filters','hideWishlisted','hideTriaged']`
  - `mergeSettings(partial?): Settings` (deep-merges `filters`)
  - `excludeReason(app, settings, ctx: {excludeIds: Set, wishlistIds: Set, triagedIds: Set}): string | null`
  - `triageAdjustments(triage: {appid, bucket, tags}[]): {up: Record<tag, number>, down: Record<tag, number>}`
  - `scoreApp(app, profile, settings, adj): {raw: number, lines: Line[]}`, where `Line = {label: string, kind: 'seed'|'slider'|'triage'|'quality', value: number}`
  - `scaleLines(lines, factor, target): Line[]` (integer values, sum === target, zero lines dropped)
  - `scoreCandidates({profile, candidates, settings, ctx: {excludeIds, wishlistIds, triage}, limit = 30, pinnedIds = new Set()}): {recs: Rec[], unscored: number, eligible: number}`, where:
    - `Rec = {appid, app, raw, score, lines, pinned: boolean}`
  - `App` (candidate record, as produced by the store in Task 4): `{appid, name, tags: Record<tag, votes> | null, developer, publisher, priceCents, reviewPct (0..1), reviewCount, releaseYear, deckVerified, modes: ('single'|'multi'|'coop')[] | null, capsuleUrl}`

- [ ] **Step 1: Write the failing tests**

`test/score.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/score.test.js`
Expected: FAIL with `Cannot find module ... public/score.js`

- [ ] **Step 3: Implement `public/score.js`**

```js
// Pure module: shared by the browser and Node tests. No DOM access.
import { voteShares } from './profile.js';

export const SLIDER_STEP = 0.15;
export const TRIAGE_STEP = 0.05;
export const QUALITY_STEP = 0.1;
export const QUALITY_PIVOT = 0.7;
export const DEFAULT_LIMIT = 30;

export const DEFAULT_SETTINGS = Object.freeze({
  sliders: {},
  blockedTags: [],
  blockedCompanies: [],
  filters: {
    maxPriceCents: null, minReviewPct: null, minReviewCount: null,
    yearMin: null, yearMax: null, deckOnly: false, mode: 'any',
  },
  hideWishlisted: false,
  hideTriaged: true,
});

export const SETTING_KEYS = ['sliders', 'blockedTags', 'blockedCompanies', 'filters', 'hideWishlisted', 'hideTriaged'];

export function mergeSettings(partial = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    sliders: { ...(partial.sliders || {}) },
    blockedTags: [...(partial.blockedTags || [])],
    blockedCompanies: [...(partial.blockedCompanies || [])],
    filters: { ...DEFAULT_SETTINGS.filters, ...(partial.filters || {}) },
  };
}

const lc = s => String(s).trim().toLowerCase();

function companies(app) {
  return [app.developer, app.publisher]
    .filter(Boolean)
    .flatMap(s => String(s).split(','))
    .map(lc)
    .filter(Boolean);
}

export function excludeReason(app, settings, ctx) {
  if (ctx.excludeIds.has(app.appid)) return 'owned';
  if (settings.hideTriaged && ctx.triagedIds.has(app.appid)) return 'triaged';
  if (settings.hideWishlisted && ctx.wishlistIds.has(app.appid)) return 'wishlisted';
  const blockedTags = new Set(settings.blockedTags.map(lc));
  if (Object.keys(app.tags || {}).some(t => blockedTags.has(lc(t)))) return 'blocked-tag';
  const blockedCos = new Set(settings.blockedCompanies.map(lc));
  if (companies(app).some(c => blockedCos.has(c))) return 'blocked-company';
  const f = settings.filters;
  if (f.maxPriceCents != null && (app.priceCents == null || app.priceCents > f.maxPriceCents)) return 'price';
  if (f.minReviewPct != null && (app.reviewPct == null || app.reviewPct < f.minReviewPct)) return 'review-pct';
  if (f.minReviewCount != null && (app.reviewCount == null || app.reviewCount < f.minReviewCount)) return 'review-count';
  if (f.yearMin != null && (app.releaseYear == null || app.releaseYear < f.yearMin)) return 'year';
  if (f.yearMax != null && (app.releaseYear == null || app.releaseYear > f.yearMax)) return 'year';
  if (f.deckOnly && app.deckVerified !== true) return 'deck';
  if (f.mode && f.mode !== 'any' && !(app.modes || []).includes(f.mode)) return 'mode';
  return null;
}

export function triageAdjustments(triage) {
  const up = {};
  const down = {};
  for (const t of triage) {
    const target = t.bucket === 'interested' ? up : t.bucket === 'not_for_me' ? down : null;
    if (!target) continue;
    for (const [tag, share] of Object.entries(voteShares(t.tags))) target[tag] = (target[tag] || 0) + share;
  }
  return { up, down };
}

export function scoreApp(app, profile, settings, adj) {
  const shares = voteShares(app.tags);
  const bySeed = new Map();
  const sliderLines = [];
  let upSum = 0;
  let downSum = 0;

  for (const [tag, share] of Object.entries(shares)) {
    const affinity = profile.affinity[tag] || 0;
    if (affinity > 0) {
      const src = profile.sources[tag][0];
      const line = bySeed.get(src.appid) || { label: `${src.name} (#${src.rank}) overlap`, kind: 'seed', value: 0 };
      line.value += affinity * share;
      bySeed.set(src.appid, line);
    }
    const v = settings.sliders[tag] || 0;
    if (v !== 0) {
      sliderLines.push({ label: `${tag} ${v > 0 ? 'boost' : 'suppress'}`, kind: 'slider', value: v * SLIDER_STEP * share });
    }
    upSum += (adj.up[tag] || 0) * share;
    downSum += (adj.down[tag] || 0) * share;
  }

  const lines = [...bySeed.values()].sort((a, b) => b.value - a.value).concat(sliderLines);
  if (upSum > 0) lines.push({ label: 'Similar to games you marked Interested', kind: 'triage', value: TRIAGE_STEP * upSum });
  if (downSum > 0) lines.push({ label: 'Similar to games you marked Not for me', kind: 'triage', value: -TRIAGE_STEP * downSum });
  const minCount = settings.filters.minReviewCount ?? 0;
  if (app.reviewPct != null && (app.reviewCount ?? 0) >= minCount) {
    lines.push({ label: 'Review score', kind: 'quality', value: QUALITY_STEP * (app.reviewPct - QUALITY_PIVOT) });
  }
  const raw = lines.reduce((sum, l) => sum + l.value, 0);
  return { raw, lines };
}

export function scaleLines(lines, factor, target) {
  const scaled = lines.map(l => ({ ...l, value: Math.round(l.value * factor) }));
  const diff = target - scaled.reduce((sum, l) => sum + l.value, 0);
  if (diff !== 0 && scaled.length) {
    let idx = 0;
    lines.forEach((l, i) => { if (Math.abs(l.value) > Math.abs(lines[idx].value)) idx = i; });
    scaled[idx].value += diff;
  }
  return scaled.filter(l => l.value !== 0);
}

export function scoreCandidates({ profile, candidates, settings, ctx, limit = DEFAULT_LIMIT, pinnedIds = new Set() }) {
  const s = mergeSettings(settings);
  const adj = triageAdjustments(ctx.triage);
  const fullCtx = { excludeIds: ctx.excludeIds, wishlistIds: ctx.wishlistIds, triagedIds: new Set(ctx.triage.map(t => t.appid)) };
  let unscored = 0;
  const scored = [];

  for (const app of candidates) {
    if (!app.tags || Object.keys(app.tags).length === 0) { unscored++; continue; }
    if (excludeReason(app, s, fullCtx)) continue;
    const { raw, lines } = scoreApp(app, profile, s, adj);
    scored.push({ app, raw, lines });
  }

  scored.sort((a, b) => b.raw - a.raw || String(a.app.name).localeCompare(String(b.app.name)));
  const top = scored.slice(0, limit);
  const topIds = new Set(top.map(r => r.app.appid));
  const pinned = scored.filter(r => pinnedIds.has(r.app.appid) && !topIds.has(r.app.appid));
  const shown = [...top, ...pinned].sort((a, b) => b.raw - a.raw);

  const maxRaw = scored.length ? scored[0].raw : 0;
  const factor = maxRaw > 0 ? 100 / maxRaw : 0;
  const recs = shown.map(r => {
    const score = Math.round(r.raw * factor);
    return { appid: r.app.appid, app: r.app, raw: r.raw, score, lines: scaleLines(r.lines, factor, score), pinned: pinnedIds.has(r.app.appid) };
  });
  return { recs, unscored, eligible: scored.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/score.test.js`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add public/score.js test/score.test.js
git commit -m "feat: add scoring engine with itemized, exact-sum breakdowns

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: HTTP helper + throttled queue

**Files:**
- Create: `lib/http.js`, `lib/throttle.js`, `test/http.test.js`, `test/throttle.test.js`

**Interfaces:**
- Produces:
  - `class HttpError extends Error { status: number; url: string }`: the message and `url` have `key=` redacted
  - `redact(url: string): string`
  - `fetchJson(fetchImpl, url): Promise<any>`: throws `HttpError` on non-2xx; throws `SyntaxError` on non-JSON
  - `isRetryable(err): boolean`: true for 429, 5xx, and any non-`HttpError` (network/JSON); false for other 4xx
  - `createThrottle({intervalMs, retries = 3, sleep?, now?}): {run<T>(fn: () => Promise<T>): Promise<T>}`

- [ ] **Step 1: Write the failing tests**

`test/http.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson, HttpError, isRetryable, redact } from '../lib/http.js';

const fakeFetch = (status, body, { json = true } = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => { if (!json) throw new SyntaxError('Unexpected token <'); return body; },
});

test('fetchJson returns parsed body on 200', async () => {
  assert.deepEqual(await fetchJson(fakeFetch(200, { a: 1 }), 'https://x.test/'), { a: 1 });
});

test('fetchJson throws HttpError with redacted key on non-2xx', async () => {
  await assert.rejects(fetchJson(fakeFetch(403, {}), 'https://x.test/?key=SECRET123&steamid=1'), err => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 403);
    assert.ok(!err.message.includes('SECRET123'));
    assert.ok(!err.url.includes('SECRET123'));
    return true;
  });
});

test('fetchJson surfaces an HTML error page as a retryable SyntaxError', async () => {
  await assert.rejects(fetchJson(fakeFetch(200, null, { json: false }), 'https://x.test/'), err => isRetryable(err));
});

test('isRetryable: 429 and 5xx yes, 404 no, network errors yes', () => {
  assert.equal(isRetryable(new HttpError(429, 'u')), true);
  assert.equal(isRetryable(new HttpError(503, 'u')), true);
  assert.equal(isRetryable(new HttpError(404, 'u')), false);
  assert.equal(isRetryable(new TypeError('fetch failed')), true);
});

test('redact hides key values anywhere in the query', () => {
  assert.equal(redact('https://a/?x=1&key=abc&y=2'), 'https://a/?x=1&key=REDACTED&y=2');
});
```

`test/throttle.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThrottle } from '../lib/throttle.js';
import { HttpError } from '../lib/http.js';

function fakeClock() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async ms => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

test('spaces consecutive calls by intervalMs and preserves order', async () => {
  const clock = fakeClock();
  const th = createThrottle({ intervalMs: 1000, ...clock });
  const order = [];
  const times = [];
  await Promise.all([1, 2, 3].map(n => th.run(async () => { order.push(n); times.push(clock.now()); return n; })));
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(times, [0, 1000, 2000]);
});

test('retries 429 with backoff then succeeds', async () => {
  const clock = fakeClock();
  const th = createThrottle({ intervalMs: 100, retries: 3, ...clock });
  let calls = 0;
  const result = await th.run(async () => { calls++; if (calls < 3) throw new HttpError(429, 'u'); return 'ok'; });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.ok(clock.sleeps.includes(200) && clock.sleeps.includes(400));
});

test('gives up after retries and rejects with the last error', async () => {
  const th = createThrottle({ intervalMs: 1, retries: 3, ...fakeClock() });
  let calls = 0;
  await assert.rejects(th.run(async () => { calls++; throw new HttpError(503, 'u'); }), /503/);
  assert.equal(calls, 4);
});

test('does not retry non-retryable errors, and later calls still run', async () => {
  const th = createThrottle({ intervalMs: 1, ...fakeClock() });
  let calls = 0;
  await assert.rejects(th.run(async () => { calls++; throw new HttpError(404, 'u'); }));
  assert.equal(calls, 1);
  assert.equal(await th.run(async () => 'next'), 'next');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/http.test.js test/throttle.test.js`
Expected: FAIL with `Cannot find module ... lib/http.js`

- [ ] **Step 3: Implement `lib/http.js`**

```js
const USER_AGENT = 'steam-recs/0.1 (personal, local use)';

export function redact(url) {
  return String(url).replace(/([?&]key=)[^&]*/gi, '$1REDACTED');
}

export class HttpError extends Error {
  constructor(status, url) {
    const safe = redact(url);
    super(`HTTP ${status} from ${safe}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = safe;
  }
}

export async function fetchJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json();
}

export function isRetryable(err) {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  return true;
}
```

- [ ] **Step 4: Implement `lib/throttle.js`**

```js
import { isRetryable } from './http.js';

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createThrottle({ intervalMs, retries = 3, sleep = realSleep, now = Date.now }) {
  let chain = Promise.resolve();
  let last = -Infinity;

  async function gate() {
    const wait = last + intervalMs - now();
    if (wait > 0) await sleep(wait);
    last = now();
  }

  function run(fn) {
    const task = chain.then(async () => {
      for (let attempt = 0; ; attempt++) {
        await gate();
        try {
          return await fn();
        } catch (err) {
          if (attempt >= retries || !isRetryable(err)) throw err;
          await sleep(intervalMs * 2 ** (attempt + 1));
        }
      }
    });
    chain = task.catch(() => {});
    return task;
  }

  return { run };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/http.test.js test/throttle.test.js`
Expected: PASS (9 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/http.js lib/throttle.js test/http.test.js test/throttle.test.js
git commit -m "feat: add JSON fetch helper with key redaction and throttled retry queue

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: SQLite store

**Files:**
- Create: `lib/store.js`, `test/store.test.js`

**Interfaces:**
- Consumes: `mergeSettings`, `SETTING_KEYS` from `public/score.js`.
- Produces `createStore(file = ':memory:')` returning:
  - `getLibrary(): LibraryGame[]`: ordered by rank, with `source: 'steam'|'manual'`
  - `importOwned(games: {appid, name, hours}[]): {added, updated}`. On the first Steam import, new games are ranked by hours descending and the top 10 seeded. On later imports, new games are appended unseeded; existing games keep rank and seed but get updated name and hours.
  - `addGame({appid, name, position?: number|null, source = 'manual', hours = 0}): void`: inserts at 0-based `position` (default: bottom), `seed = true`, un-hides if it already exists
  - `reorder(appids: number[]): void`: listed IDs get ranks 0..n-1; unlisted ones keep their relative order after them
  - `setSeed(appid, bool): boolean`, `setHidden(appid, bool): boolean`: return false if the appid is unknown
  - `upsertApp(patch: Partial<App> & {appid, tagsAt?, detailsAt?}): void`: merges into the existing row
  - `getApp(appid): App & {tagsAt, detailsAt} | null`, `getApps(appids: number[]): App[]`
  - `setTriage(appid, bucket)`: throws `RangeError` on a bad bucket. Also `clearTriage(appid)` and `getTriage(): {appid, bucket, createdAt}[]`
  - `getSettings(): Settings` (merged with defaults), `patchSettings(patch): Settings` (only `SETTING_KEYS` are stored)
  - `getValue(key, fallback)`, `setValue(key, value)`: internal JSON values (`wishlist`, `candidateIds`, `catalogFinishedAt`, `claudeLatest`)
  - `close()`

- [ ] **Step 1: Write the failing tests**

`test/store.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/store.test.js`
Expected: FAIL with `Cannot find module ... lib/store.js`

- [ ] **Step 3: Implement `lib/store.js`**

```js
import Database from 'better-sqlite3';
import { mergeSettings, SETTING_KEYS } from '../public/score.js';

export const DEFAULT_SEED_COUNT = 10;
export const BUCKETS = ['interested', 'not_for_me', 'played'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS library (
  appid INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'steam',
  hours REAL NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL,
  seed INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS apps (
  appid INTEGER PRIMARY KEY,
  name TEXT, tags_json TEXT, developer TEXT, publisher TEXT,
  price_cents INTEGER, review_pct REAL, review_count INTEGER, release_year INTEGER,
  deck_verified INTEGER, modes_json TEXT, capsule_url TEXT,
  tags_at INTEGER, details_at INTEGER
);
CREATE TABLE IF NOT EXISTS triage (
  appid INTEGER PRIMARY KEY,
  bucket TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
`;

const toLib = r => ({
  appid: r.appid, name: r.name, source: r.source, hours: r.hours,
  rank: r.rank, seed: !!r.seed, hidden: !!r.hidden,
});

const parse = s => (s == null ? null : JSON.parse(s));

const toApp = r => ({
  appid: r.appid,
  name: r.name,
  tags: parse(r.tags_json),
  developer: r.developer,
  publisher: r.publisher,
  priceCents: r.price_cents,
  reviewPct: r.review_pct,
  reviewCount: r.review_count,
  releaseYear: r.release_year,
  deckVerified: r.deck_verified == null ? null : !!r.deck_verified,
  modes: parse(r.modes_json),
  capsuleUrl: r.capsule_url,
  tagsAt: r.tags_at,
  detailsAt: r.details_at,
});

export function createStore(file = ':memory:', { now = Date.now } = {}) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const getLibrary = () => db.prepare('SELECT * FROM library ORDER BY rank, appid').all().map(toLib);

  const reorder = db.transaction(appids => {
    const listed = new Set(appids);
    const rest = getLibrary().filter(g => !listed.has(g.appid)).map(g => g.appid);
    const stmt = db.prepare('UPDATE library SET rank = ? WHERE appid = ?');
    [...appids, ...rest].forEach((id, i) => stmt.run(i, id));
  });

  const importOwned = db.transaction(games => {
    const existing = new Set(db.prepare('SELECT appid FROM library').all().map(r => r.appid));
    const firstImport = db.prepare("SELECT COUNT(*) AS n FROM library WHERE source = 'steam'").get().n === 0;
    const update = db.prepare('UPDATE library SET name = ?, hours = ? WHERE appid = ?');
    const insert = db.prepare('INSERT INTO library (appid, name, source, hours, rank, seed) VALUES (?, ?, ?, ?, ?, ?)');
    let next = (db.prepare('SELECT MAX(rank) AS m FROM library').get().m ?? -1) + 1;
    const fresh = games.filter(g => !existing.has(g.appid));
    if (firstImport) fresh.sort((a, b) => b.hours - a.hours);
    for (const g of games) if (existing.has(g.appid)) update.run(g.name, g.hours, g.appid);
    fresh.forEach((g, i) => insert.run(g.appid, g.name, 'steam', g.hours, next++, firstImport && i < DEFAULT_SEED_COUNT ? 1 : 0));
    return { added: fresh.length, updated: games.length - fresh.length };
  });

  const addGame = db.transaction(({ appid, name, position = null, source = 'manual', hours = 0 }) => {
    const exists = db.prepare('SELECT 1 FROM library WHERE appid = ?').get(appid);
    if (exists) db.prepare('UPDATE library SET hidden = 0, seed = 1 WHERE appid = ?').run(appid);
    else db.prepare('INSERT INTO library (appid, name, source, hours, rank, seed) VALUES (?, ?, ?, ?, -1, 1)').run(appid, name, source, hours);
    const order = getLibrary().filter(g => g.appid !== appid).map(g => g.appid);
    const pos = position == null ? order.length : Math.max(0, Math.min(Number(position), order.length));
    order.splice(pos, 0, appid);
    reorder(order);
  });

  const setFlag = column => (appid, value) =>
    db.prepare(`UPDATE library SET ${column} = ? WHERE appid = ?`).run(value ? 1 : 0, appid).changes > 0;

  function getApp(appid) {
    const row = db.prepare('SELECT * FROM apps WHERE appid = ?').get(appid);
    return row ? toApp(row) : null;
  }

  function getApps(appids) {
    if (!appids.length) return [];
    return db.prepare('SELECT * FROM apps WHERE appid IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...new Set(appids)]))
      .map(toApp);
  }

  function upsertApp(patch) {
    const a = { ...(getApp(patch.appid) || { appid: patch.appid }), ...patch };
    db.prepare(`INSERT OR REPLACE INTO apps
      (appid, name, tags_json, developer, publisher, price_cents, review_pct, review_count,
       release_year, deck_verified, modes_json, capsule_url, tags_at, details_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      a.appid, a.name ?? null, a.tags == null ? null : JSON.stringify(a.tags),
      a.developer ?? null, a.publisher ?? null, a.priceCents ?? null, a.reviewPct ?? null,
      a.reviewCount ?? null, a.releaseYear ?? null, a.deckVerified == null ? null : (a.deckVerified ? 1 : 0),
      a.modes == null ? null : JSON.stringify(a.modes), a.capsuleUrl ?? null, a.tagsAt ?? null, a.detailsAt ?? null,
    );
  }

  function setTriage(appid, bucket) {
    if (!BUCKETS.includes(bucket)) throw new RangeError(`Unknown triage bucket: ${bucket}`);
    db.prepare('INSERT OR REPLACE INTO triage (appid, bucket, created_at) VALUES (?, ?, ?)').run(appid, bucket, now());
  }

  const clearTriage = appid => db.prepare('DELETE FROM triage WHERE appid = ?').run(appid);
  const getTriage = () => db.prepare('SELECT * FROM triage ORDER BY created_at, appid').all()
    .map(r => ({ appid: r.appid, bucket: r.bucket, createdAt: r.created_at }));

  function getValue(key, fallback) {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value_json) : fallback;
  }

  function setValue(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(key, JSON.stringify(value));
  }

  function getSettings() {
    const stored = {};
    for (const key of SETTING_KEYS) {
      const v = getValue(`setting:${key}`, undefined);
      if (v !== undefined) stored[key] = v;
    }
    return mergeSettings(stored);
  }

  function patchSettings(patch) {
    const merged = mergeSettings({ ...getSettings(), ...patch, filters: { ...getSettings().filters, ...(patch.filters || {}) } });
    for (const key of SETTING_KEYS) if (key in patch) setValue(`setting:${key}`, merged[key]);
    return getSettings();
  }

  return {
    getLibrary, importOwned, addGame, reorder,
    setSeed: setFlag('seed'), setHidden: setFlag('hidden'),
    upsertApp, getApp, getApps,
    setTriage, clearTriage, getTriage,
    getSettings, patchSettings, getValue, setValue,
    close: () => db.close(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/store.test.js`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/store.js test/store.test.js
git commit -m "feat: add SQLite store for library, app cache, triage, and settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Steam + SteamSpy clients

**Files:**
- Create: `lib/steam.js`, `lib/steamspy.js`, `test/steam.test.js`, `test/steamspy.test.js`

**Interfaces:**
- Consumes: `fetchJson` from `lib/http.js`.
- Produces:
  - `class SteamError extends Error { code: 'missing_config'|'vanity_not_found'|'private_profile' }`
  - `capsuleFor(appid): string`
  - `createSteamClient({apiKey, steamId, fetch?})` returning:
    - `configured: boolean`
    - `resolveSteamId(): Promise<string>`
    - `getOwnedGames(): Promise<{appid, name, hours}[]>` (hours rounded to 0.1)
    - `getWishlist(): Promise<number[]>` (never throws; returns `[]` on any failure)
    - `searchStore(term): Promise<{appid, name, capsuleUrl}[]>`
    - `getAppDetails(appid): Promise<{name, releaseYear, modes, priceCents, capsuleUrl} | null>`
    - `getDeckVerified(appid): Promise<boolean | null>`
  - `createSteamSpyClient({fetch?})` returning:
    - `getAppDetails(appid): Promise<{appid, name, tags, developer, publisher, priceCents, reviewPct, reviewCount} | null>` (`tags` is always an object)
    - `listByTag(tag): Promise<{appid, name, positive, negative}[]>`
    - `listTop2Weeks(): Promise<{appid, name, positive, negative}[]>`

- [ ] **Step 1: Write the failing tests**

`test/steam.test.js`:

```js
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
```

`test/steamspy.test.js`:

```js
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
    publisher: 'Supergiant Games', priceCents: 2499, reviewPct: 0.9, reviewCount: 1000,
  });
});

test('getAppDetails turns SteamSpy empty-array tags into {} and zero reviews into null pct', async () => {
  const spy = createSteamSpyClient({ fetch: fetchReturning({ appid: 2, name: 'New', positive: 0, negative: 0, price: '', tags: [] }) });
  const d = await spy.getAppDetails(2);
  assert.deepEqual(d.tags, {});
  assert.equal(d.reviewPct, null);
  assert.equal(d.priceCents, null);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/steam.test.js test/steamspy.test.js`
Expected: FAIL with `Cannot find module ... lib/steam.js`

- [ ] **Step 3: Implement `lib/steam.js`**

```js
import { fetchJson } from './http.js';

const API = 'https://api.steampowered.com';
const STORE = 'https://store.steampowered.com';

// Store category ids → play modes used by the "play mode" filter.
const MODE_CATEGORIES = {
  2: 'single',
  1: 'multi', 36: 'multi', 47: 'multi', 49: 'multi',
  9: 'coop', 38: 'coop', 39: 'coop', 48: 'coop',
};

export class SteamError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SteamError';
    this.code = code;
  }
}

export const capsuleFor = appid => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_184x69.jpg`;

export function createSteamClient({ apiKey, steamId, fetch: fetchImpl = globalThis.fetch }) {
  const configured = Boolean(apiKey && steamId);
  let resolvedId = null;

  async function resolveSteamId() {
    if (!configured) throw new SteamError('missing_config', 'Steam is not configured. Add STEAM_API_KEY and STEAM_ID to .env and restart.');
    if (resolvedId) return resolvedId;
    if (/^\d{17}$/.test(steamId)) return (resolvedId = steamId);
    const data = await fetchJson(fetchImpl, `${API}/ISteamUser/ResolveVanityURL/v1/?key=${apiKey}&vanityurl=${encodeURIComponent(steamId)}`);
    if (data?.response?.success !== 1) {
      throw new SteamError('vanity_not_found', `Could not resolve Steam profile name "${steamId}". Put your 17-digit SteamID64 in STEAM_ID instead.`);
    }
    return (resolvedId = data.response.steamid);
  }

  async function getOwnedGames() {
    const id = await resolveSteamId();
    const data = await fetchJson(fetchImpl, `${API}/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${id}&include_appinfo=1&include_played_free_games=1`);
    const games = data?.response?.games;
    if (!Array.isArray(games) || games.length === 0) {
      throw new SteamError('private_profile', 'Steam returned no games. In Steam, open Profile > Edit Profile > Privacy Settings and set "Game details" to Public, then import again.');
    }
    return games.map(g => ({ appid: g.appid, name: g.name, hours: Math.round((g.playtime_forever || 0) / 6) / 10 }));
  }

  async function getWishlist() {
    try {
      const id = await resolveSteamId();
      const data = await fetchJson(fetchImpl, `${API}/IWishlistService/GetWishlist/v1/?steamid=${id}`);
      return (data?.response?.items || []).map(i => i.appid);
    } catch {
      return [];
    }
  }

  async function searchStore(term) {
    const data = await fetchJson(fetchImpl, `${STORE}/api/storesearch/?term=${encodeURIComponent(term)}&cc=US&l=en`);
    return (data?.items || [])
      .filter(i => !i.type || i.type === 'app')
      .map(i => ({ appid: i.id, name: i.name, capsuleUrl: i.tiny_image || capsuleFor(i.id) }));
  }

  async function getAppDetails(appid) {
    const data = await fetchJson(fetchImpl, `${STORE}/api/appdetails?appids=${appid}&cc=US&l=en`);
    const entry = data?.[appid];
    if (!entry?.success || !entry.data) return null;
    const d = entry.data;
    const year = Number((d.release_date?.date || '').match(/\b(19|20)\d{2}\b/)?.[0]) || null;
    const modes = [...new Set((d.categories || []).map(c => MODE_CATEGORIES[c.id]).filter(Boolean))];
    return {
      name: d.name,
      releaseYear: year,
      modes,
      priceCents: d.is_free ? 0 : d.price_overview?.final ?? null,
      capsuleUrl: d.capsule_image || capsuleFor(appid),
    };
  }

  async function getDeckVerified(appid) {
    const data = await fetchJson(fetchImpl, `${STORE}/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${appid}&l=english`);
    const category = data?.results?.resolved_category;
    return category == null ? null : category === 3;
  }

  return { configured, resolveSteamId, getOwnedGames, getWishlist, searchStore, getAppDetails, getDeckVerified };
}
```

- [ ] **Step 4: Implement `lib/steamspy.js`**

```js
import { fetchJson } from './http.js';

const SPY = 'https://steamspy.com/api.php';

const toListRow = r => ({
  appid: Number(r.appid),
  name: r.name,
  positive: Number(r.positive) || 0,
  negative: Number(r.negative) || 0,
});

const toList = data => Object.values(data || {}).map(toListRow).filter(r => r.appid > 0);

export function createSteamSpyClient({ fetch: fetchImpl = globalThis.fetch } = {}) {
  async function getAppDetails(appid) {
    const d = await fetchJson(fetchImpl, `${SPY}?request=appdetails&appid=${appid}`);
    if (!d || !d.name) return null;
    const positive = Number(d.positive) || 0;
    const negative = Number(d.negative) || 0;
    const price = d.price === '' || d.price == null ? null : Number(d.price);
    return {
      appid,
      name: d.name,
      tags: d.tags && !Array.isArray(d.tags) ? d.tags : {},
      developer: d.developer || null,
      publisher: d.publisher || null,
      priceCents: Number.isFinite(price) ? price : null,
      reviewPct: positive + negative > 0 ? positive / (positive + negative) : null,
      reviewCount: positive + negative,
    };
  }

  const listByTag = async tag => toList(await fetchJson(fetchImpl, `${SPY}?request=tag&tag=${encodeURIComponent(tag)}`));
  const listTop2Weeks = async () => toList(await fetchJson(fetchImpl, `${SPY}?request=top100in2weeks`));

  return { getAppDetails, listByTag, listTop2Weeks };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/steam.test.js test/steamspy.test.js`
Expected: PASS (13 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/steam.js lib/steamspy.js test/steam.test.js test/steamspy.test.js
git commit -m "feat: add Steam Web API, store, and SteamSpy clients

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Catalog builder

**Files:**
- Create: `lib/catalog.js`, `test/catalog.test.js`

**Interfaces:**
- Consumes: the store (Task 4), the Steam client and SteamSpy client (Task 5), `createThrottle(...).run` (Task 3), `buildProfile` (Task 1).
- Produces:
  - `FRESH_MS = 7 * 24 * 3600 * 1000`, `TOP_TAGS = 8`, `PER_TAG = 40`
  - `createCatalog({store, steam, spy, spyThrottle, storeThrottle, now?, log?})` returning:
    - `refresh(): Promise<void> | null`: starts a build and returns its promise, or `null` if one is already running. Never rejects; errors go to `status().error`.
    - `status(): {running, phase: 'idle'|'library'|'lists'|'details'|'library-rest', done, total, failed, error, candidateCount, finishedAt, stale}`
    - `ensureTags(appid): Promise<App|null>`, `ensureApp(appid): Promise<App|null>` (tags + details; throttled; skips fresh data)

- [ ] **Step 1: Write the failing tests**

`test/catalog.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { createCatalog, FRESH_MS, PER_TAG } from '../lib/catalog.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/catalog.test.js`
Expected: FAIL with `Cannot find module ... lib/catalog.js`

- [ ] **Step 3: Implement `lib/catalog.js`**

```js
import { buildProfile } from '../public/profile.js';

export const FRESH_MS = 7 * 24 * 3600 * 1000;
export const TOP_TAGS = 8;
export const PER_TAG = 40;

export function createCatalog({ store, steam, spy, spyThrottle, storeThrottle, now = Date.now, log = console }) {
  const state = { running: false, phase: 'idle', done: 0, total: 0, failed: 0, error: null };
  const isFresh = ts => ts != null && now() - ts < FRESH_MS;

  async function ensureTags(appid) {
    const cur = store.getApp(appid);
    if (cur && isFresh(cur.tagsAt)) return cur;
    const d = await spyThrottle.run(() => spy.getAppDetails(appid));
    store.upsertApp({ ...(d || { appid }), tagsAt: now() });
    return store.getApp(appid);
  }

  async function ensureDetails(appid) {
    const cur = store.getApp(appid);
    if (cur && isFresh(cur.detailsAt)) return;
    const details = await storeThrottle.run(() => steam.getAppDetails(appid));
    const deck = await storeThrottle.run(() => steam.getDeckVerified(appid));
    store.upsertApp({ appid, ...(details || {}), deckVerified: deck, detailsAt: now() });
  }

  async function ensureApp(appid) {
    await ensureTags(appid);
    await ensureDetails(appid);
    return store.getApp(appid);
  }

  async function step(appid, fn) {
    try {
      await fn();
    } catch (err) {
      state.failed++;
      log.warn?.(`catalog: app ${appid} failed: ${err.message}`);
    } finally {
      state.done++;
    }
  }

  function setPhase(phase, total) {
    Object.assign(state, { phase, done: 0, total });
  }

  async function collectCandidates(topTags, ownedIds) {
    const ids = new Set();
    try {
      for (const r of await spyThrottle.run(() => spy.listTop2Weeks())) ids.add(r.appid);
      for (const tag of topTags) {
        const list = await spyThrottle.run(() => spy.listByTag(tag));
        list.sort((a, b) => b.positive - a.positive).slice(0, PER_TAG).forEach(r => ids.add(r.appid));
      }
    } catch (err) {
      const cached = store.getValue('candidateIds', []);
      if (!cached.length) throw err;
      state.error = `Using cached candidate list (${err.message})`;
      cached.forEach(id => ids.add(id));
    }
    return [...ids].filter(id => !ownedIds.has(id));
  }

  async function build() {
    const library = store.getLibrary().filter(g => !g.hidden);
    const seeded = library.filter(g => g.seed);
    setPhase('library', seeded.length);
    for (const g of seeded) await step(g.appid, () => ensureTags(g.appid));

    setPhase('lists', TOP_TAGS + 1);
    const appsById = new Map(store.getApps(library.map(g => g.appid)).map(a => [a.appid, a]));
    const topTags = buildProfile(library, appsById).topTags.slice(0, TOP_TAGS);
    const ownedIds = new Set(store.getLibrary().map(g => g.appid));
    const candidates = await collectCandidates(topTags, ownedIds);
    store.setValue('candidateIds', candidates);

    setPhase('details', candidates.length);
    for (const id of candidates) await step(id, () => ensureApp(id));

    const rest = library.filter(g => !g.seed);
    setPhase('library-rest', rest.length);
    for (const g of rest) await step(g.appid, () => ensureTags(g.appid));

    store.setValue('catalogFinishedAt', now());
  }

  function refresh() {
    if (state.running) return null;
    Object.assign(state, { running: true, phase: 'library', done: 0, total: 0, failed: 0, error: null });
    return build()
      .catch(err => {
        state.error = err.message;
        log.error?.(`catalog: build failed: ${err.message}`);
      })
      .finally(() => {
        state.running = false;
        state.phase = 'idle';
      });
  }

  function status() {
    const finishedAt = store.getValue('catalogFinishedAt', null);
    return {
      ...state,
      candidateCount: store.getValue('candidateIds', []).length,
      finishedAt,
      stale: finishedAt != null && !isFresh(finishedAt),
    };
  }

  return { refresh, status, ensureTags, ensureApp };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/catalog.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/catalog.js test/catalog.test.js
git commit -m "feat: add resumable background catalog builder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Claude client

**Files:**
- Create: `lib/claude.js`, `test/claude.test.js`

**Interfaces:**
- Produces:
  - `CLAUDE_MODEL = 'claude-opus-5-5'`, `MAX_WILDCARDS = 3`
  - `buildPrompt({seeds: string[], topTags: string[], notForMe: string[], recs: {appid, name, tags: string[]}[]}): string`
  - `createClaudeClient({apiKey, client?})` returning:
    - `enabled: boolean`
    - `annotate(input): Promise<{blurbs: Record<appid, string>, wildcards: {name, blurb}[]}>`. Throws on refusal, invalid JSON, or API error. Blurbs are limited to the requested appids, and wildcards are capped at 3.
  - `resolveWildcards({wildcards: {name, blurb}[], search: (term) => Promise<{appid, name}[]>, excludeIds: Set<number>}): Promise<{appid, name, blurb}[]>`

- [ ] **Step 1: Write the failing tests**

`test/claude.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeClient, buildPrompt, resolveWildcards, CLAUDE_MODEL, MAX_WILDCARDS } from '../lib/claude.js';

const input = {
  seeds: ['Hades', 'Slay the Spire'],
  topTags: ['Roguelike', 'Deckbuilding'],
  notForMe: ['Some Horror Game'],
  recs: [{ appid: 1, name: 'Dead Cells', tags: ['Roguelike'] }, { appid: 2, name: 'Balatro', tags: ['Deckbuilding'] }],
};

function fakeClient(response) {
  const requests = [];
  return {
    requests,
    beta: { messages: { create: async req => { requests.push(req); if (response instanceof Error) throw response; return response; } } },
  };
}

const textResponse = obj => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });

test('disabled without an API key', () => {
  assert.equal(createClaudeClient({ apiKey: '' }).enabled, false);
});

test('annotate sends model, low effort, fallback, schema; parses blurbs and caps wildcards', async () => {
  const client = fakeClient(textResponse({
    blurbs: [{ appid: 1, blurb: 'Fast runs like Hades.' }, { appid: 999, blurb: 'not requested' }],
    wildcards: [1, 2, 3, 4].map(i => ({ name: `W${i}`, blurb: `b${i}` })),
  }));
  const c = createClaudeClient({ apiKey: 'k', client });
  const out = await c.annotate(input);
  const req = client.requests[0];
  assert.equal(req.model, CLAUDE_MODEL);
  assert.equal(req.output_config.effort, 'low');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.deepEqual(out.blurbs, { 1: 'Fast runs like Hades.' });
  assert.equal(out.wildcards.length, MAX_WILDCARDS);
});

test('annotate throws on refusal', async () => {
  const c = createClaudeClient({ apiKey: 'k', client: fakeClient({ stop_reason: 'refusal', content: [] }) });
  await assert.rejects(c.annotate(input), /declined/);
});

test('annotate propagates API errors', async () => {
  const c = createClaudeClient({ apiKey: 'k', client: fakeClient(new Error('overloaded')) });
  await assert.rejects(c.annotate(input), /overloaded/);
});

test('buildPrompt includes seeds, tags, rejects, and candidate appids', () => {
  const p = buildPrompt(input);
  for (const s of ['Hades', 'Roguelike', 'Some Horror Game', '"appid": 1', 'Balatro']) assert.ok(p.includes(s), s);
});

test('resolveWildcards matches exact titles, then prefix, and drops excluded or unknown', async () => {
  const catalog = {
    'Outer Wilds': [{ appid: 10, name: 'Outer Wilds' }, { appid: 11, name: 'Outer Wilds - Echoes of the Eye' }],
    'Tunic': [{ appid: 20, name: 'TUNIC' }],
    'Owned Game': [{ appid: 30, name: 'Owned Game' }],
    'Nope': [],
    'Celeste': [{ appid: 40, name: 'Celeste Classic' }],
  };
  const search = async term => { if (term === 'Boom') throw new Error('down'); return catalog[term] || []; };
  const out = await resolveWildcards({
    wildcards: ['Outer Wilds', 'Tunic', 'Owned Game', 'Nope', 'Celeste', 'Boom'].map(name => ({ name, blurb: `why ${name}` })),
    search,
    excludeIds: new Set([30]),
  });
  assert.deepEqual(out, [
    { appid: 10, name: 'Outer Wilds', blurb: 'why Outer Wilds' },
    { appid: 20, name: 'TUNIC', blurb: 'why Tunic' },
    { appid: 40, name: 'Celeste Classic', blurb: 'why Celeste' },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/claude.test.js`
Expected: FAIL with `Cannot find module ... lib/claude.js`

- [ ] **Step 3: Implement `lib/claude.js`**

```js
import Anthropic from '@anthropic-ai/sdk';

export const CLAUDE_MODEL = 'claude-opus-5-5';
export const MAX_WILDCARDS = 3;

const SYSTEM = `You help one player find their next PC game on Steam.
You receive the player's favorite games (most important first), their strongest tag preferences, games they rejected, and a list of candidates a scoring engine already picked.
1. For each candidate, write one sentence (at most 25 words) on why this player in particular would enjoy it. Refer to their favorites where it fits. Do not restate the game's name or list its tags.
2. Suggest exactly 3 wildcard games that are sold on Steam, are not among the candidates or favorites, and that a tag-matching engine would likely miss, such as standouts from adjacent genres. Use each game's exact Steam store title and give it a one-sentence blurb in the same style.`;

const SCHEMA = {
  type: 'object',
  properties: {
    blurbs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { appid: { type: 'integer' }, blurb: { type: 'string' } },
        required: ['appid', 'blurb'],
        additionalProperties: false,
      },
    },
    wildcards: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, blurb: { type: 'string' } },
        required: ['name', 'blurb'],
        additionalProperties: false,
      },
    },
  },
  required: ['blurbs', 'wildcards'],
  additionalProperties: false,
};

export function buildPrompt({ seeds, topTags, notForMe, recs }) {
  return [
    `Favorite games, most important first: ${seeds.join(', ') || '(none yet)'}`,
    `Strongest tag preferences: ${topTags.join(', ') || '(none yet)'}`,
    `Rejected ("not for me"): ${notForMe.join(', ') || '(none)'}`,
    'Candidates:',
    JSON.stringify(recs, null, 1),
  ].join('\n');
}

export function createClaudeClient({ apiKey, client = apiKey ? new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 }) : null }) {
  async function annotate(input) {
    if (!client) throw new Error('Claude is not configured');
    const response = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: buildPrompt(input) }],
    });
    if (response.stop_reason === 'refusal') throw new Error('Claude declined the request');
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed = JSON.parse(text);
    const requested = new Set(input.recs.map(r => r.appid));
    const blurbs = Object.fromEntries(parsed.blurbs.filter(b => requested.has(b.appid)).map(b => [b.appid, b.blurb]));
    return { blurbs, wildcards: parsed.wildcards.slice(0, MAX_WILDCARDS) };
  }

  return { enabled: Boolean(client), annotate };
}

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

export async function resolveWildcards({ wildcards, search, excludeIds }) {
  const out = [];
  for (const w of wildcards) {
    let results;
    try {
      results = await search(w.name);
    } catch {
      continue;
    }
    const target = norm(w.name);
    const match = results.find(r => norm(r.name) === target) || results.find(r => norm(r.name).startsWith(target));
    if (!match || excludeIds.has(match.appid) || out.some(o => o.appid === match.appid)) continue;
    out.push({ appid: match.appid, name: match.name, blurb: w.blurb });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/claude.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/claude.js test/claude.test.js
git commit -m "feat: add optional Claude blurbs and wildcard picks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: HTTP API + server entry

**Files:**
- Create: `lib/app.js`, `server.js`, `test/app.test.js`, `.env.example`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces `createApp({store, steam, catalog, claude})`, an Express app with these routes:

| Method + path | Body | Response |
|---|---|---|
| `GET /api/state` | none | `{config: {steamConfigured, claudeEnabled}, library, settings, triage, wishlist, candidateIds, apps, claude, catalog}` |
| `POST /api/import` | none | `{added, updated}`; errors: 400 `missing_config`, 422 `private_profile` or `vanity_not_found` |
| `PUT /api/library/order` | `{appids: int[]}` | `{library}` |
| `PATCH /api/library/:appid` | `{seed?: bool, hidden?: bool}` | `{library}`; 404 if unknown |
| `POST /api/library` | `{appid, name, position?}` | `{library, app}` |
| `GET /api/search?q=` | none | `{results: [{appid, name, capsuleUrl}]}`; `q` must be ≥ 2 characters |
| `PUT /api/triage/:appid` | `{bucket}` | `{triage}`; 400 on a bad bucket |
| `DELETE /api/triage/:appid` | none | `{triage}` |
| `PUT /api/settings` | partial settings | `{settings}`; 400 on invalid values |
| `POST /api/catalog/refresh` | none | 202 `{started: true}` or 409 `{started: false}` |
| `GET /api/catalog/status` | none | the catalog status object |
| `POST /api/claude/annotate` | `{appids: int[]}` | `{enabled: false}` or `{enabled: true, blurbs, wildcards: [{appid, blurb}], apps, error?}` |

- Every error body is `{error: string, message: string}`. Unknown upstream failures return 502, with no API key in the message.
- Static files are served from `public/`, and `/vendor/Sortable.min.js` is served from `node_modules/sortablejs/`.

- [ ] **Step 1: Write the failing tests**

`test/app.test.js`:

```js
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
  res = await request(app).delete('/api/triage/5').expect(200);
  assert.deepEqual(res.body.triage, []);
});

test('settings validation', async () => {
  const { app } = setup();
  const res = await request(app).put('/api/settings').send({ sliders: { Roguelike: 2 }, filters: { maxPriceCents: 0 } }).expect(200);
  assert.equal(res.body.settings.sliders.Roguelike, 2);
  assert.equal(res.body.settings.filters.maxPriceCents, 0);
  await request(app).put('/api/settings').send({ sliders: { Roguelike: 5 } }).expect(400);
  await request(app).put('/api/settings').send({ filters: { mode: 'mmo' } }).expect(400);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/app.test.js`
Expected: FAIL with `Cannot find module ... lib/app.js`

- [ ] **Step 3: Implement `lib/app.js`**

```js
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SteamError } from './steam.js';
import { BUCKETS } from './store.js';
import { resolveWildcards } from './claude.js';
import { buildProfile } from '../public/profile.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODES = ['any', 'single', 'multi', 'coop'];
const CLAUDE_REC_LIMIT = 30;

class BadRequest extends Error {
  constructor(message) { super(message); this.status = 400; this.code = 'bad_request'; }
}

const isInt = v => Number.isInteger(v);
const isNullableNumber = v => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

function parseAppid(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequest('appid must be a positive integer');
  return n;
}

function parseAppids(raw) {
  if (!Array.isArray(raw) || !raw.every(v => isInt(v) && v > 0)) throw new BadRequest('appids must be an array of positive integers');
  return raw;
}

function validateSettings(body) {
  const out = {};
  if ('sliders' in body) {
    const ok = body.sliders && typeof body.sliders === 'object' && !Array.isArray(body.sliders)
      && Object.values(body.sliders).every(v => isInt(v) && v >= -2 && v <= 2);
    if (!ok) throw new BadRequest('sliders must map tag names to integers from -2 to 2');
    out.sliders = Object.fromEntries(Object.entries(body.sliders).filter(([, v]) => v !== 0));
  }
  for (const key of ['blockedTags', 'blockedCompanies']) {
    if (key in body) {
      if (!Array.isArray(body[key]) || !body[key].every(s => typeof s === 'string' && s.trim())) throw new BadRequest(`${key} must be an array of non-empty strings`);
      out[key] = [...new Set(body[key].map(s => s.trim()))];
    }
  }
  for (const key of ['hideWishlisted', 'hideTriaged']) {
    if (key in body) {
      if (typeof body[key] !== 'boolean') throw new BadRequest(`${key} must be a boolean`);
      out[key] = body[key];
    }
  }
  if ('filters' in body) {
    const f = body.filters;
    if (!f || typeof f !== 'object') throw new BadRequest('filters must be an object');
    for (const key of ['maxPriceCents', 'minReviewPct', 'minReviewCount', 'yearMin', 'yearMax']) {
      if (key in f && !isNullableNumber(f[key])) throw new BadRequest(`filters.${key} must be null or a non-negative number`);
    }
    if ('minReviewPct' in f && f.minReviewPct != null && f.minReviewPct > 1) throw new BadRequest('filters.minReviewPct must be between 0 and 1');
    if ('deckOnly' in f && typeof f.deckOnly !== 'boolean') throw new BadRequest('filters.deckOnly must be a boolean');
    if ('mode' in f && !MODES.includes(f.mode)) throw new BadRequest(`filters.mode must be one of ${MODES.join(', ')}`);
    out.filters = f;
  }
  return out;
}

export function createApp({ store, steam, catalog, claude }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/vendor/Sortable.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules', 'sortablejs', 'Sortable.min.js')));
  app.use(express.static(path.join(root, 'public')));

  app.get('/api/state', (req, res) => {
    const library = store.getLibrary();
    const triage = store.getTriage();
    const candidateIds = store.getValue('candidateIds', []);
    const claudeLatest = store.getValue('claudeLatest', null);
    const wildcardIds = (claudeLatest?.wildcards || []).map(w => w.appid);
    const ids = [...library.map(g => g.appid), ...candidateIds, ...triage.map(t => t.appid), ...wildcardIds];
    res.json({
      config: { steamConfigured: steam.configured, claudeEnabled: claude.enabled },
      library,
      settings: store.getSettings(),
      triage,
      wishlist: store.getValue('wishlist', []),
      candidateIds,
      apps: store.getApps(ids),
      claude: claudeLatest,
      catalog: catalog.status(),
    });
  });

  app.post('/api/import', async (req, res) => {
    const games = await steam.getOwnedGames();
    const result = store.importOwned(games);
    store.setValue('wishlist', await steam.getWishlist());
    res.json(result);
  });

  app.put('/api/library/order', (req, res) => {
    store.reorder(parseAppids(req.body?.appids));
    res.json({ library: store.getLibrary() });
  });

  app.patch('/api/library/:appid', (req, res) => {
    const appid = parseAppid(req.params.appid);
    const { seed, hidden } = req.body || {};
    if (seed !== undefined && typeof seed !== 'boolean') throw new BadRequest('seed must be a boolean');
    if (hidden !== undefined && typeof hidden !== 'boolean') throw new BadRequest('hidden must be a boolean');
    let found = store.getLibrary().some(g => g.appid === appid);
    if (found && seed !== undefined) found = store.setSeed(appid, seed);
    if (found && hidden !== undefined) found = store.setHidden(appid, hidden);
    if (!found) return res.status(404).json({ error: 'not_found', message: `App ${appid} is not in your library` });
    res.json({ library: store.getLibrary() });
  });

  app.post('/api/library', async (req, res) => {
    const appid = parseAppid(req.body?.appid);
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : `App ${appid}`;
    const position = req.body?.position;
    if (position != null && !(isInt(position) && position >= 0)) throw new BadRequest('position must be a non-negative integer');
    store.addGame({ appid, name, position: position ?? null });
    const appRecord = await catalog.ensureApp(appid).catch(() => store.getApp(appid));
    res.json({ library: store.getLibrary(), app: appRecord });
  });

  app.get('/api/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) throw new BadRequest('Search needs at least 2 characters');
    res.json({ results: await steam.searchStore(q) });
  });

  app.put('/api/triage/:appid', (req, res) => {
    const appid = parseAppid(req.params.appid);
    if (!BUCKETS.includes(req.body?.bucket)) throw new BadRequest(`bucket must be one of ${BUCKETS.join(', ')}`);
    store.setTriage(appid, req.body.bucket);
    res.json({ triage: store.getTriage() });
  });

  app.delete('/api/triage/:appid', (req, res) => {
    store.clearTriage(parseAppid(req.params.appid));
    res.json({ triage: store.getTriage() });
  });

  app.put('/api/settings', (req, res) => {
    res.json({ settings: store.patchSettings(validateSettings(req.body || {})) });
  });

  app.post('/api/catalog/refresh', (req, res) => {
    const started = catalog.refresh();
    res.status(started ? 202 : 409).json({ started: Boolean(started) });
  });

  app.get('/api/catalog/status', (req, res) => res.json(catalog.status()));

  app.post('/api/claude/annotate', async (req, res) => {
    if (!claude.enabled) return res.json({ enabled: false });
    const appids = parseAppids(req.body?.appids ?? []).slice(0, CLAUDE_REC_LIMIT);
    const library = store.getLibrary();
    const triage = store.getTriage();
    const libIds = new Set(library.map(g => g.appid));
    const appsById = new Map(store.getApps([...libIds, ...appids, ...triage.map(t => t.appid)]).map(a => [a.appid, a]));
    const profile = buildProfile(library, appsById);
    const input = {
      seeds: profile.seeds.slice(0, 10).map(s => s.name),
      topTags: profile.topTags.slice(0, 10),
      notForMe: triage.filter(t => t.bucket === 'not_for_me').map(t => appsById.get(t.appid)?.name).filter(Boolean),
      recs: appids.map(id => appsById.get(id)).filter(Boolean)
        .map(a => ({ appid: a.appid, name: a.name, tags: Object.keys(a.tags || {}).slice(0, 6) })),
    };
    try {
      const out = await claude.annotate(input);
      const excludeIds = new Set([...libIds, ...triage.map(t => t.appid), ...appids]);
      const resolved = await resolveWildcards({ wildcards: out.wildcards, search: term => steam.searchStore(term), excludeIds });
      const apps = [];
      for (const w of resolved) {
        const a = await catalog.ensureApp(w.appid).catch(() => null);
        if (a) apps.push(a);
      }
      const wildcards = resolved.filter(w => apps.some(a => a.appid === w.appid)).map(w => ({ appid: w.appid, blurb: w.blurb }));
      const latest = {
        blurbs: { ...out.blurbs, ...Object.fromEntries(wildcards.map(w => [w.appid, w.blurb])) },
        wildcards,
        createdAt: Date.now(),
      };
      store.setValue('claudeLatest', latest);
      res.json({ enabled: true, ...latest, apps });
    } catch (err) {
      res.json({ enabled: true, error: `Claude unavailable: ${err.message}`, blurbs: {}, wildcards: [], apps: [] });
    }
  });

  // Express 5 forwards rejected async handlers here.
  app.use((err, req, res, next) => {
    if (err instanceof SteamError) {
      return res.status(err.code === 'missing_config' ? 400 : 422).json({ error: err.code, message: err.message });
    }
    if (err instanceof BadRequest || err instanceof RangeError || err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'bad_request', message: err.message });
    }
    console.error(err);
    res.status(502).json({ error: 'upstream', message: `Upstream request failed: ${err.message}` });
  });

  return app;
}
```

- [ ] **Step 4: Implement `server.js` and `.env.example`**

`server.js`:

```js
import { createApp } from './lib/app.js';
import { createStore } from './lib/store.js';
import { createSteamClient } from './lib/steam.js';
import { createSteamSpyClient } from './lib/steamspy.js';
import { createCatalog } from './lib/catalog.js';
import { createClaudeClient } from './lib/claude.js';
import { createThrottle } from './lib/throttle.js';

const store = createStore(process.env.DB_PATH || 'steam-recs.db');
const steam = createSteamClient({ apiKey: process.env.STEAM_API_KEY, steamId: process.env.STEAM_ID });
const catalog = createCatalog({
  store,
  steam,
  spy: createSteamSpyClient(),
  spyThrottle: createThrottle({ intervalMs: 1100 }),
  storeThrottle: createThrottle({ intervalMs: 1500 }),
});
const claude = createClaudeClient({ apiKey: process.env.ANTHROPIC_API_KEY });

const port = Number(process.env.PORT) || 3000;
createApp({ store, steam, catalog, claude }).listen(port, '127.0.0.1', () => {
  console.log(`Steam Recs running at http://localhost:${port}`);
  console.log(`Steam: ${steam.configured ? 'configured' : 'NOT configured (manual library only)'} | Claude: ${claude.enabled ? 'on' : 'off'}`);
});
```

`.env.example`:

```
# Get a key at https://steamcommunity.com/dev/apikey
STEAM_API_KEY=
# 17-digit SteamID64 (or your custom profile URL name)
STEAM_ID=
# Optional: enables blurbs and wildcard picks on Regenerate
ANTHROPIC_API_KEY=
PORT=3000
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS: all suites from Tasks 1–8, 0 failures.

- [ ] **Step 6: Smoke-test that the server boots without keys**

Run: `node server.js` (in the background), then `curl -s http://localhost:3000/api/state`, then stop the server.
Expected: the log shows `Steam: NOT configured`, and the JSON contains `"steamConfigured":false`.

- [ ] **Step 7: Commit**

```bash
git add lib/app.js server.js test/app.test.js .env.example
git commit -m "feat: add HTTP API and server entry point

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Pure frontend helpers

**Files:**
- Create: `public/format.js`, `public/ui/tune-form.js`, `test/format.test.js`, `test/tune-form.test.js`

**Interfaces:**
- Produces:
  - `format.js`:
    - `escapeHtml(s)`
    - `capsuleFor(appid)`
    - `formatPrice(cents)`: `—`, `Free`, or `$x.yy`
    - `formatReview(pct)`: `—` or `NN%`
    - `formatSigned(n)`: `+5`, `−3`, or `0`
    - `topReason(lines)`
    - `formatAge(ms)`: `today`, `1 day ago`, or `N days ago`
  - `tune-form.js`:
    - `readFilters(form): {filters, hideWishlisted, hideTriaged}`, where `form` is any object with `.maxPrice.value`, `.minReviewPct.value`, `.minReviewCount.value`, `.yearMin.value`, `.yearMax.value`, `.deckOnly.checked`, `.mode.value`, `.hideWishlisted.checked`, `.hideTriaged.checked`
    - `writeFilters(form, settings): void`, the inverse of `readFilters`

- [ ] **Step 1: Write the failing tests**

`test/format.test.js`:

```js
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
```

`test/tune-form.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFilters, writeFilters } from '../public/ui/tune-form.js';
import { mergeSettings } from '../public/score.js';

const blankForm = () => ({
  maxPrice: { value: '' }, minReviewPct: { value: '' }, minReviewCount: { value: '' },
  yearMin: { value: '' }, yearMax: { value: '' }, deckOnly: { checked: false },
  mode: { value: 'any' }, hideWishlisted: { checked: false }, hideTriaged: { checked: true },
});

test('blank fields mean no limit', () => {
  const out = readFilters(blankForm());
  assert.deepEqual(out.filters, { maxPriceCents: null, minReviewPct: null, minReviewCount: null, yearMin: null, yearMax: null, deckOnly: false, mode: 'any' });
  assert.equal(out.hideTriaged, true);
});

test('0 max price means free only; percents and dollars convert', () => {
  const f = blankForm();
  f.maxPrice.value = '0';
  f.minReviewPct.value = '85';
  f.yearMin.value = '2015';
  assert.equal(readFilters(f).filters.maxPriceCents, 0);
  assert.equal(readFilters(f).filters.minReviewPct, 0.85);
  f.maxPrice.value = '19.99';
  assert.equal(readFilters(f).filters.maxPriceCents, 1999);
  assert.equal(readFilters(f).filters.yearMin, 2015);
});

test('non-numeric or negative input is treated as blank', () => {
  const f = blankForm();
  f.maxPrice.value = 'abc';
  f.minReviewCount.value = '-5';
  const out = readFilters(f).filters;
  assert.equal(out.maxPriceCents, null);
  assert.equal(out.minReviewCount, null);
});

test('writeFilters round-trips through readFilters', () => {
  const settings = mergeSettings({ filters: { maxPriceCents: 1999, minReviewPct: 0.8, deckOnly: true, mode: 'coop' }, hideWishlisted: true });
  const f = blankForm();
  writeFilters(f, settings);
  assert.equal(f.maxPrice.value, '19.99');
  assert.equal(f.minReviewPct.value, '80');
  const back = readFilters(f);
  assert.deepEqual(back.filters, settings.filters);
  assert.equal(back.hideWishlisted, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/format.test.js test/tune-form.test.js`
Expected: FAIL with `Cannot find module ... public/format.js`

- [ ] **Step 3: Implement `public/format.js`**

```js
// Pure display helpers. No DOM access at import time.
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const DAY_MS = 24 * 3600 * 1000;

export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ENTITIES[c]);

export const capsuleFor = appid => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_184x69.jpg`;

export function formatPrice(cents) {
  if (cents == null) return '—';
  if (cents === 0) return 'Free';
  return `$${(cents / 100).toFixed(2)}`;
}

export const formatReview = pct => (pct == null ? '—' : `${Math.round(pct * 100)}%`);

export function formatSigned(n) {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return '0';
}

export function topReason(lines) {
  const best = lines.filter(l => l.value > 0).sort((a, b) => b.value - a.value)[0];
  return best ? best.label : 'Matches your filters';
}

export function formatAge(ms) {
  const days = Math.floor(ms / DAY_MS);
  if (days < 1) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
```

- [ ] **Step 4: Implement `public/ui/tune-form.js`**

```js
// Pure conversion between the filter form and settings. `form` only needs
// .value / .checked on the named fields, so tests can pass plain objects.
function num(raw) {
  if (raw === '' || raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function readFilters(form) {
  const price = num(form.maxPrice.value);
  const pct = num(form.minReviewPct.value);
  const count = num(form.minReviewCount.value);
  const yearMin = num(form.yearMin.value);
  const yearMax = num(form.yearMax.value);
  return {
    filters: {
      maxPriceCents: price == null ? null : Math.round(price * 100),
      minReviewPct: pct == null ? null : Math.min(pct, 100) / 100,
      minReviewCount: count == null ? null : Math.round(count),
      yearMin: yearMin == null ? null : Math.round(yearMin),
      yearMax: yearMax == null ? null : Math.round(yearMax),
      deckOnly: Boolean(form.deckOnly.checked),
      mode: form.mode.value || 'any',
    },
    hideWishlisted: Boolean(form.hideWishlisted.checked),
    hideTriaged: Boolean(form.hideTriaged.checked),
  };
}

export function writeFilters(form, settings) {
  const f = settings.filters;
  form.maxPrice.value = f.maxPriceCents == null ? '' : (f.maxPriceCents / 100).toFixed(2).replace(/\.00$/, '');
  form.minReviewPct.value = f.minReviewPct == null ? '' : String(Math.round(f.minReviewPct * 100));
  form.minReviewCount.value = f.minReviewCount == null ? '' : String(f.minReviewCount);
  form.yearMin.value = f.yearMin == null ? '' : String(f.yearMin);
  form.yearMax.value = f.yearMax == null ? '' : String(f.yearMax);
  form.deckOnly.checked = f.deckOnly;
  form.mode.value = f.mode;
  form.hideWishlisted.checked = settings.hideWishlisted;
  form.hideTriaged.checked = settings.hideTriaged;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/format.test.js test/tune-form.test.js`
Expected: PASS (10 tests)

- [ ] **Step 6: Commit**

```bash
git add public/format.js public/ui/tune-form.js test/format.test.js test/tune-form.test.js
git commit -m "feat: add pure display and filter-form helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Cockpit UI

**Files:**
- Create: `public/index.html`, `public/style.css`, `public/api.js`, `public/ui/library.js`, `public/ui/recs.js`, `public/ui/tune.js`, `public/app.js`

**Interfaces:**
- Consumes: the API routes from Task 8; `buildProfile` (Task 1); `scoreCandidates`, `mergeSettings` (Task 2); `format.js` and `tune-form.js` (Task 9); the global `Sortable` from `/vendor/Sortable.min.js`.
- Produces:
  - `renderLibrary(el: {list, hidden}, {library, apps})`
  - `renderRecs(el: {list, unscored, zones}, {recs, unscored, blurbs, expanded, triage, catalogEmpty})`
  - `renderTune(el: {tags, blocked, companies, form}, {settings, topTags, allTags, tagQuery})`
  - `api.get/post/put/patch/del`: throws an `Error` with `.status` and `.code` on non-2xx

- [ ] **Step 1: Write `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Steam Recs</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="topbar">
    <h1>Steam Recs</h1>
    <button id="btn-import" type="button">Import from Steam</button>
    <button id="btn-regenerate" type="button" class="primary">Regenerate</button>
    <span id="catalog-status" class="status"></span>
  </header>
  <div id="banner" class="banner" hidden></div>

  <main class="cockpit">
    <section class="panel" id="library-panel" aria-labelledby="library-title">
      <div class="panel-head">
        <h2 id="library-title">My Library</h2>
        <button id="btn-add" type="button" class="small">+ add game</button>
      </div>
      <p class="hint">Drag to rank. Higher = more weight. ☑ = seed.</p>
      <ol id="library-list" class="library-list"></ol>
      <div id="library-hidden"></div>
    </section>

    <section class="panel" id="recs-panel" aria-labelledby="recs-title">
      <div class="panel-head">
        <h2 id="recs-title">Recommendations</h2>
        <span id="unscored" class="muted"></span>
      </div>
      <ul id="rec-list" class="rec-list"></ul>
      <div class="zones">
        <div class="zone" id="zone-interested" data-bucket="interested">
          <button type="button" class="zone-head" data-action="toggle-zone">Interested <span class="count">0</span></button>
          <ul class="zone-drop"></ul>
          <ul class="zone-items"></ul>
        </div>
        <div class="zone" id="zone-not_for_me" data-bucket="not_for_me">
          <button type="button" class="zone-head" data-action="toggle-zone">Not for me <span class="count">0</span></button>
          <ul class="zone-drop"></ul>
          <ul class="zone-items"></ul>
        </div>
        <div class="zone" id="zone-played" data-bucket="played">
          <button type="button" class="zone-head" data-action="toggle-zone">Played <span class="count">0</span></button>
          <ul class="zone-drop"></ul>
          <ul class="zone-items"></ul>
        </div>
      </div>
    </section>

    <section class="panel" id="tune" aria-labelledby="tune-title">
      <h2 id="tune-title">Tune</h2>
      <h3>Tags</h3>
      <input id="tag-search" type="search" placeholder="Search any tag…" autocomplete="off">
      <ul id="tag-list" class="tag-list"></ul>
      <div class="chips-label">Blocked tags</div>
      <div id="blocked-tags" class="chips"></div>

      <form id="filters" class="filters" autocomplete="off">
        <h3>Filters</h3>
        <label>Max price ($) <input name="maxPrice" type="number" min="0" step="0.01" placeholder="any"></label>
        <label>Min review % <input name="minReviewPct" type="number" min="0" max="100" placeholder="any"></label>
        <label>Min reviews <input name="minReviewCount" type="number" min="0" placeholder="any"></label>
        <label>Released from <input name="yearMin" type="number" min="1990" max="2100" placeholder="any"></label>
        <label>Released to <input name="yearMax" type="number" min="1990" max="2100" placeholder="any"></label>
        <label class="check"><input name="deckOnly" type="checkbox"> Steam Deck verified only</label>
        <label>Play mode
          <select name="mode">
            <option value="any">Any</option>
            <option value="single">Single-player</option>
            <option value="multi">Multiplayer</option>
            <option value="coop">Co-op</option>
          </select>
        </label>
        <h3>Exclusions</h3>
        <label class="check"><input type="checkbox" checked disabled> Hide games I own</label>
        <label class="check"><input name="hideWishlisted" type="checkbox"> Hide wishlisted</label>
        <label class="check"><input name="hideTriaged" type="checkbox"> Hide triaged</label>
      </form>
      <label class="company-label">Blocked developers/publishers
        <input id="company-input" type="text" placeholder="Type a name, press Enter">
      </label>
      <div id="blocked-companies" class="chips"></div>
    </section>
  </main>

  <dialog id="add-dialog">
    <form method="dialog" class="dialog-body">
      <h2>Add a game</h2>
      <input id="add-search" type="search" placeholder="Search the Steam store…" autocomplete="off">
      <ul id="add-results" class="add-results"></ul>
      <menu><button value="cancel">Close</button></menu>
    </form>
  </dialog>

  <dialog id="played-dialog">
    <form method="dialog" class="dialog-body">
      <h2>Add <span id="played-name"></span> to your library</h2>
      <label>At rank <input id="played-rank" type="number" min="1"></label>
      <menu>
        <button value="cancel">Cancel</button>
        <button value="ok" class="primary">Add</button>
      </menu>
    </form>
  </dialog>

  <script src="/vendor/Sortable.min.js"></script>
  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `public/style.css`**

```css
:root {
  --bg: #171a21; --panel: #1b2838; --panel-2: #22334a; --line: #2f4560;
  --text: #c7d5e0; --muted: #8299ad; --accent: #66c0f4; --pos: #a4d007; --neg: #e05d5d; --warn: #e2b04a;
  font-family: system-ui, "Segoe UI", sans-serif; font-size: 14px; color: var(--text); background: var(--bg);
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; }
button, input, select { font: inherit; color: inherit; }
button { background: var(--panel-2); border: 1px solid var(--line); border-radius: 4px; padding: 6px 12px; cursor: pointer; }
button:hover { border-color: var(--accent); }
button.primary { background: #2a6db0; border-color: #2a6db0; color: #fff; }
button.small { padding: 2px 8px; font-size: 12px; }
button.icon { background: none; border: none; padding: 0 4px; color: var(--muted); }
button.icon:hover { color: var(--neg); }
button.link { background: none; border: none; padding: 0; color: var(--accent); text-decoration: underline; }
input[type="text"], input[type="search"], input[type="number"], select {
  background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 4px 6px; width: 100%;
}

.topbar { display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: #0e141b; border-bottom: 1px solid var(--line); }
.topbar h1 { font-size: 18px; margin: 0 12px 0 0; color: #fff; }
.status { margin-left: auto; color: var(--muted); font-size: 12px; }
.status.stale { color: var(--warn); }
.banner { padding: 8px 16px; background: #3a2f12; color: #f3d98b; border-bottom: 1px solid #5c4a1a; }
.banner p { margin: 2px 0; }

.cockpit { flex: 1; display: grid; grid-template-columns: minmax(260px, 1fr) minmax(420px, 2fr) minmax(260px, 1fr); gap: 12px; padding: 12px; min-height: 0; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 12px; display: flex; flex-direction: column; min-height: 0; max-height: calc(100vh - 80px); overflow: auto; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.panel h2 { font-size: 15px; margin: 0 0 6px; color: #fff; }
.panel h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 14px 0 6px; }
.hint, .muted { color: var(--muted); font-size: 12px; margin: 0 0 8px; }
.empty { color: var(--muted); padding: 12px; list-style: none; text-align: center; }

.library-list { list-style: none; margin: 0; padding: 0; }
.lib-row { display: grid; grid-template-columns: 16px 24px 46px 1fr auto 20px 18px; align-items: center; gap: 6px; padding: 4px; border-bottom: 1px solid var(--line); }
.lib-row .handle { cursor: grab; color: var(--muted); }
.lib-row .rank { color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
.lib-row .thumb { width: 46px; height: 17px; object-fit: cover; border-radius: 2px; }
.lib-row .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lib-row .hours { color: var(--muted); font-size: 12px; }
.sortable-ghost { opacity: .4; }
#library-hidden details { margin-top: 8px; color: var(--muted); }
.hidden-row { padding: 2px 0; }

.rec-list { list-style: none; margin: 0; padding: 0; flex: 1; }
.rec { border: 1px solid var(--line); border-radius: 6px; margin-bottom: 6px; background: var(--panel-2); cursor: grab; }
.rec-head { display: grid; grid-template-columns: 120px 1fr auto; gap: 10px; align-items: center; padding: 6px; }
.rec .capsule { width: 120px; height: 45px; object-fit: cover; border-radius: 3px; }
.rec-title { font-weight: 600; color: #fff; }
.rec-reason, .rec-meta { font-size: 12px; color: var(--muted); }
.rec-score { font-size: 18px; font-weight: 700; color: var(--accent); padding-right: 6px; }
.wild { margin-right: 4px; }
.rec-body { padding: 4px 10px 10px 136px; cursor: default; }
.breakdown { border-collapse: collapse; width: 100%; max-width: 420px; font-size: 12px; }
.breakdown td { padding: 1px 4px; border-bottom: 1px dotted var(--line); }
.breakdown td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
.breakdown .pos { color: var(--pos); }
.breakdown .neg { color: var(--neg); }
.blurb { font-style: italic; margin: 8px 0; }
.rec-body a { color: var(--accent); }

.zones { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; position: sticky; bottom: 0; background: var(--panel); padding-top: 6px; }
.zone { position: relative; border: 2px dashed var(--line); border-radius: 6px; min-height: 52px; }
.zone-head { width: 100%; background: none; border: none; padding: 14px 8px; font-weight: 600; }
.zone .count { display: inline-block; min-width: 20px; border-radius: 10px; background: var(--panel-2); margin-left: 4px; }
.zone-drop { list-style: none; margin: 0; padding: 0; position: absolute; inset: 0; display: none; }
body.dragging .zone-drop { display: block; }
body.dragging .zone { border-color: var(--accent); }
.zone-drop .rec { display: none; }
.zone-items { display: none; list-style: none; margin: 0; padding: 0 8px 8px; font-size: 12px; max-height: 160px; overflow: auto; }
.zone.open .zone-items { display: block; }

.tag-list { list-style: none; margin: 6px 0; padding: 0; }
.tag-row { display: grid; grid-template-columns: 1fr 90px 26px 18px; align-items: center; gap: 6px; padding: 2px 0; }
.tag-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tag-val { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
.chips-label { font-size: 12px; color: var(--muted); margin-top: 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
.chip { background: var(--panel-2); border: 1px solid var(--line); border-radius: 12px; padding: 1px 4px 1px 10px; font-size: 12px; }
.filters label, .company-label { display: block; margin-bottom: 6px; font-size: 12px; color: var(--muted); }
.filters label.check { display: flex; gap: 6px; align-items: center; color: var(--text); }
.filters label.check input { width: auto; }

dialog { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 8px; min-width: 380px; }
dialog::backdrop { background: rgba(0, 0, 0, .6); }
.dialog-body h2 { font-size: 16px; margin-top: 0; }
.dialog-body menu { display: flex; justify-content: flex-end; gap: 8px; padding: 0; margin: 12px 0 0; }
.add-results { list-style: none; margin: 8px 0 0; padding: 0; max-height: 300px; overflow: auto; }
.add-results li button { width: 100%; text-align: left; display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
.add-results img { width: 60px; height: 22px; object-fit: cover; }

@media (max-width: 1100px) {
  .cockpit { grid-template-columns: 1fr; }
  .panel { max-height: none; }
}
```

- [ ] **Step 3: Write `public/api.js`**

```js
async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.error;
    throw err;
  }
  return data;
}

export const api = {
  get: url => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  patch: (url, body) => request('PATCH', url, body),
  del: url => request('DELETE', url),
};
```

- [ ] **Step 4: Write `public/ui/library.js`**

```js
import { escapeHtml, capsuleFor } from '../format.js';

export function renderLibrary(el, { library, apps }) {
  const visible = library.filter(g => !g.hidden);
  const hidden = library.filter(g => g.hidden);

  el.list.innerHTML = visible.length
    ? visible.map((g, i) => {
      const thumb = apps.get(g.appid)?.capsuleUrl || capsuleFor(g.appid);
      return `<li class="lib-row" data-appid="${g.appid}">
        <span class="handle" title="Drag to rank">≡</span>
        <span class="rank">${i + 1}</span>
        <img class="thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy">
        <span class="name" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</span>
        <span class="hours">${g.hours ? `${g.hours}h` : ''}</span>
        <input type="checkbox" data-action="seed" title="Use as a seed" ${g.seed ? 'checked' : ''}>
        <button type="button" class="icon" data-action="hide" title="Hide from profile">×</button>
      </li>`;
    }).join('')
    : '<li class="empty">Import from Steam or add a game to start.</li>';

  el.hidden.innerHTML = hidden.length
    ? `<details><summary>Hidden (${hidden.length})</summary>${hidden.map(g =>
      `<div class="hidden-row">${escapeHtml(g.name)} <button type="button" class="link" data-action="unhide" data-appid="${g.appid}">restore</button></div>`).join('')}</details>`
    : '';
}
```

- [ ] **Step 5: Write `public/ui/recs.js`**

```js
import { escapeHtml, capsuleFor, formatPrice, formatReview, formatSigned, topReason } from '../format.js';

export const BUCKETS = ['interested', 'not_for_me', 'played'];

function card(rec, { blurb, expanded }) {
  const a = rec.app;
  const deck = a.deckVerified ? ' · Deck ✓' : '';
  const body = expanded
    ? `<div class="rec-body">
        <table class="breakdown">${rec.lines.map(l =>
          `<tr><td>${escapeHtml(l.label)}</td><td class="${l.value < 0 ? 'neg' : 'pos'}">${formatSigned(l.value)}</td></tr>`).join('')}
          <tr><td><strong>Score</strong></td><td><strong>${rec.score}</strong></td></tr>
        </table>
        ${blurb ? `<p class="blurb">“${escapeHtml(blurb)}”${rec.pinned ? ' (Claude)' : ''}</p>` : ''}
        <a href="https://store.steampowered.com/app/${a.appid}/" target="_blank" rel="noopener">Open in Steam ↗</a>
      </div>`
    : '';
  return `<li class="rec${expanded ? ' open' : ''}" data-appid="${a.appid}">
    <div class="rec-head" data-action="expand">
      <img class="capsule" src="${escapeHtml(a.capsuleUrl || capsuleFor(a.appid))}" alt="" loading="lazy">
      <div>
        <div class="rec-title">${rec.pinned ? '<span class="wild" title="Claude wildcard pick">✨</span>' : ''}${escapeHtml(a.name)}</div>
        <div class="rec-reason">${escapeHtml(topReason(rec.lines))}</div>
        <div class="rec-meta">${formatPrice(a.priceCents)} · ${formatReview(a.reviewPct)} positive${deck}</div>
      </div>
      <div class="rec-score">${rec.score}%</div>
    </div>
    ${body}
  </li>`;
}

export function renderRecs(el, { recs, unscored, blurbs, expanded, triage, catalogEmpty }) {
  el.list.innerHTML = recs.length
    ? recs.map(r => card(r, { blurb: blurbs[r.appid], expanded: expanded.has(r.appid) })).join('')
    : `<li class="empty">${catalogEmpty
      ? 'No catalog yet. Click Regenerate to build it (the first build takes 10–20 minutes; results appear as they arrive).'
      : 'No games match your current filters.'}</li>`;
  el.unscored.textContent = unscored ? `${unscored} games unscored (no tag data)` : '';

  for (const bucket of BUCKETS) {
    const items = triage.filter(t => t.bucket === bucket);
    const zone = el.zones[bucket];
    zone.querySelector('.count').textContent = items.length;
    zone.querySelector('.zone-items').innerHTML = items.map(t =>
      `<li>${escapeHtml(t.name)} <button type="button" class="link" data-action="untriage" data-appid="${t.appid}">undo</button></li>`).join('')
      || '<li class="muted">Drag recommendations here</li>';
  }
}
```

- [ ] **Step 6: Write `public/ui/tune.js`**

```js
import { escapeHtml, formatSigned } from '../format.js';
import { writeFilters } from './tune-form.js';

const chip = (label, action) =>
  `<span class="chip">${escapeHtml(label)} <button type="button" class="icon" data-action="${action}" data-value="${escapeHtml(label)}" title="Remove">✕</button></span>`;

export function renderTune(el, { settings, topTags, allTags, tagQuery }) {
  const blocked = new Set(settings.blockedTags);
  const q = tagQuery.trim().toLowerCase();
  const tags = q
    ? allTags.filter(t => t.toLowerCase().includes(q) && !blocked.has(t)).slice(0, 30)
    : topTags.filter(t => !blocked.has(t)).slice(0, 20);

  el.tags.innerHTML = tags.map(t => {
    const v = settings.sliders[t] || 0;
    return `<li class="tag-row" data-tag="${escapeHtml(t)}">
      <span class="tag-name" title="${escapeHtml(t)}">${escapeHtml(t)}</span>
      <input type="range" min="-2" max="2" step="1" value="${v}" data-action="slider" aria-label="Weight for ${escapeHtml(t)}">
      <span class="tag-val">${formatSigned(v)}</span>
      <button type="button" class="icon" data-action="block" title="Block this tag">✕</button>
    </li>`;
  }).join('') || '<li class="empty">No matching tags</li>';

  el.blocked.innerHTML = settings.blockedTags.map(t => chip(t, 'unblock-tag')).join('') || '<span class="muted">None</span>';
  el.companies.innerHTML = settings.blockedCompanies.map(c => chip(c, 'unblock-company')).join('');
  writeFilters(el.form, settings);
}
```

- [ ] **Step 7: Write `public/app.js`**

```js
import { api } from './api.js';
import { buildProfile } from './profile.js';
import { scoreCandidates, mergeSettings } from './score.js';
import { renderLibrary } from './ui/library.js';
import { renderRecs, BUCKETS } from './ui/recs.js';
import { renderTune } from './ui/tune.js';
import { readFilters } from './ui/tune-form.js';
import { escapeHtml, formatAge, capsuleFor } from './format.js';

const $ = sel => document.querySelector(sel);
const POLL_MS = 2000;
const RELOAD_EVERY_POLLS = 5;
const SAVE_DEBOUNCE_MS = 300;

const state = {
  config: {}, library: [], apps: new Map(), candidateIds: [], triage: [], wishlist: [],
  settings: mergeSettings(), claude: null, catalog: null,
  expanded: new Set(), tagQuery: '', notice: null, busy: null,
};

const el = {
  banner: $('#banner'),
  status: $('#catalog-status'),
  tunePanel: $('#tune'),
  library: { list: $('#library-list'), hidden: $('#library-hidden') },
  recs: { list: $('#rec-list'), unscored: $('#unscored'), zones: Object.fromEntries(BUCKETS.map(b => [b, $(`#zone-${b}`)])) },
  tune: { tags: $('#tag-list'), blocked: $('#blocked-tags'), companies: $('#blocked-companies'), form: $('#filters') },
};

// ---------- state ----------

function hydrate(s) {
  state.config = s.config;
  state.library = s.library;
  state.apps = new Map(s.apps.map(a => [a.appid, a]));
  state.candidateIds = s.candidateIds;
  state.triage = s.triage;
  state.wishlist = s.wishlist;
  state.settings = mergeSettings(s.settings);
  state.claude = s.claude;
  state.catalog = s.catalog;
}

async function reload() {
  hydrate(await api.get('/api/state'));
  // 'auto' leaves the Tune panel alone while the user is interacting with it
  // (e.g. mid-slider-drag during a background catalog poll).
  render();
}

function compute() {
  const profile = buildProfile(state.library, state.apps);
  const wildcardIds = new Set((state.claude?.wildcards || []).map(w => w.appid));
  const ids = [...new Set([...state.candidateIds, ...wildcardIds])];
  const candidates = ids.map(id => state.apps.get(id)).filter(Boolean);
  const result = scoreCandidates({
    profile,
    candidates,
    settings: state.settings,
    pinnedIds: wildcardIds,
    ctx: {
      excludeIds: new Set(state.library.map(g => g.appid)),
      wishlistIds: new Set(state.wishlist),
      triage: state.triage.map(t => ({ ...t, tags: state.apps.get(t.appid)?.tags })),
    },
  });
  const allTags = [...new Set([...state.apps.values()].flatMap(a => Object.keys(a.tags || {})))].sort();
  return { profile, allTags, ...result };
}

// ---------- rendering ----------

function render({ tune = 'auto' } = {}) {
  const r = compute();
  renderLibrary(el.library, { library: state.library, apps: state.apps });
  renderRecs(el.recs, {
    recs: r.recs,
    unscored: r.unscored,
    blurbs: state.claude?.blurbs || {},
    expanded: state.expanded,
    triage: state.triage.map(t => ({ ...t, name: state.apps.get(t.appid)?.name ?? `App ${t.appid}` })),
    catalogEmpty: state.candidateIds.length === 0,
  });
  const tuneFocused = el.tunePanel.contains(document.activeElement);
  if (tune === true || (tune === 'auto' && !tuneFocused)) {
    renderTune(el.tune, { settings: state.settings, topTags: r.profile.topTags, allTags: r.allTags, tagQuery: state.tagQuery });
  }
  renderStatus();
  return r;
}

function renderStatus() {
  const c = state.catalog;
  let text;
  if (state.busy) text = state.busy;
  else if (c?.running) text = `Building catalog: ${c.phase} ${c.done}/${c.total}${c.failed ? ` (${c.failed} failed)` : ''}`;
  else if (c?.finishedAt) text = `${c.candidateCount} candidates · data from ${formatAge(Date.now() - c.finishedAt)}${c.failed ? ` · ${c.failed} failed` : ''}`;
  else text = 'No catalog yet';
  if (c?.error) text += ` · ${c.error}`;
  el.status.textContent = text;
  el.status.classList.toggle('stale', Boolean(c?.stale));

  const msgs = [];
  if (!state.config.steamConfigured) msgs.push('Steam is not configured: add STEAM_API_KEY and STEAM_ID to .env and restart. You can still add games by hand.');
  if (state.notice) msgs.push(state.notice);
  el.banner.innerHTML = msgs.map(m => `<p>${escapeHtml(m)}</p>`).join('');
  el.banner.hidden = msgs.length === 0;
  $('#btn-import').disabled = !state.config.steamConfigured;
}

// ---------- persistence ----------

async function persist(promise) {
  try {
    return await promise;
  } catch (err) {
    state.notice = err.message;
    await reload();
    return null;
  }
}

let saveTimer = null;
function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { sliders, blockedTags, blockedCompanies, filters, hideWishlisted, hideTriaged } = state.settings;
    persist(api.put('/api/settings', { sliders, blockedTags, blockedCompanies, filters, hideWishlisted, hideTriaged }));
  }, SAVE_DEBOUNCE_MS);
}

// ---------- actions ----------

const actions = {
  reorder(appids) {
    const byId = new Map(state.library.map(g => [g.appid, g]));
    const listed = new Set(appids);
    const rest = state.library.filter(g => !listed.has(g.appid));
    state.library = [...appids.map(id => byId.get(id)), ...rest].map((g, i) => ({ ...g, rank: i }));
    render({ tune: true });
    persist(api.put('/api/library/order', { appids }));
  },

  setSeed(appid, seed) {
    state.library = state.library.map(g => (g.appid === appid ? { ...g, seed } : g));
    render({ tune: true });
    persist(api.patch(`/api/library/${appid}`, { seed }));
  },

  setHidden(appid, hidden) {
    state.library = state.library.map(g => (g.appid === appid ? { ...g, hidden } : g));
    render({ tune: true });
    persist(api.patch(`/api/library/${appid}`, { hidden }));
  },

  triage(appid, bucket) {
    if (bucket === 'played') return openPlayedDialog(appid);
    state.triage = [...state.triage.filter(t => t.appid !== appid), { appid, bucket }];
    render();
    persist(api.put(`/api/triage/${appid}`, { bucket }));
  },

  untriage(appid) {
    state.triage = state.triage.filter(t => t.appid !== appid);
    render();
    persist(api.del(`/api/triage/${appid}`));
  },

  toggleExpand(appid) {
    if (state.expanded.has(appid)) state.expanded.delete(appid);
    else state.expanded.add(appid);
    render();
  },

  updateSettings(patch, { tune = 'auto' } = {}) {
    state.settings = mergeSettings({ ...state.settings, ...patch });
    render({ tune });
    saveSettingsSoon();
  },

  async importSteam() {
    state.busy = 'Importing from Steam…';
    renderStatus();
    try {
      const r = await api.post('/api/import');
      state.notice = `Imported from Steam: ${r.added} new, ${r.updated} updated.`;
    } catch (err) {
      state.notice = err.message;
    }
    state.busy = null;
    await reload();
  },

  async regenerate() {
    state.notice = null;
    try {
      await api.post('/api/catalog/refresh');
    } catch (err) {
      if (err.status !== 409) { state.notice = err.message; renderStatus(); return; }
    }
    await pollCatalog();
    await askClaude();
  },
};

async function pollCatalog() {
  for (let i = 1; ; i++) {
    state.catalog = await api.get('/api/catalog/status');
    renderStatus();
    if (!state.catalog.running) break;
    if (i % RELOAD_EVERY_POLLS === 0) await reload();
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  await reload();
}

async function askClaude() {
  if (!state.config.claudeEnabled) return;
  const { recs } = compute();
  state.busy = 'Asking Claude for blurbs and wildcards…';
  renderStatus();
  try {
    const res = await api.post('/api/claude/annotate', { appids: recs.filter(r => !r.pinned).map(r => r.appid) });
    if (res.error) state.notice = res.error;
  } catch (err) {
    state.notice = `Claude unavailable: ${err.message}`;
  }
  state.busy = null;
  await reload();
}

// ---------- dialogs ----------

function openPlayedDialog(appid) {
  const dialog = $('#played-dialog');
  const name = state.apps.get(appid)?.name ?? `App ${appid}`;
  const visibleCount = state.library.filter(g => !g.hidden).length;
  $('#played-name').textContent = name;
  const rankInput = $('#played-rank');
  rankInput.max = String(visibleCount + 1);
  rankInput.value = String(visibleCount + 1);
  dialog.returnValue = '';
  dialog.onclose = async () => {
    if (dialog.returnValue !== 'ok') { render(); return; }
    const rank = Math.max(1, Math.min(Number(rankInput.value) || visibleCount + 1, visibleCount + 1));
    const visible = state.library.filter(g => !g.hidden);
    const before = visible[rank - 1];
    const position = before ? state.library.findIndex(g => g.appid === before.appid) : state.library.length;
    await persist(api.post('/api/library', { appid, name, position }));
    await persist(api.put(`/api/triage/${appid}`, { bucket: 'played' }));
    await reload();
  };
  dialog.showModal();
}

let searchTimer = null;
function wireAddDialog() {
  const dialog = $('#add-dialog');
  const input = $('#add-search');
  const results = $('#add-results');
  $('#btn-add').addEventListener('click', () => {
    input.value = '';
    results.innerHTML = '';
    dialog.showModal();
    input.focus();
  });
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      try {
        const { results: items } = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
        results.innerHTML = items.slice(0, 15).map(i => `<li><button type="button" data-appid="${i.appid}" data-name="${escapeHtml(i.name)}">
          <img src="${escapeHtml(i.capsuleUrl || capsuleFor(i.appid))}" alt="">${escapeHtml(i.name)}</button></li>`).join('')
          || '<li class="muted">No results</li>';
      } catch (err) {
        results.innerHTML = `<li class="muted">${escapeHtml(err.message)}</li>`;
      }
    }, SAVE_DEBOUNCE_MS);
  });
  results.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-appid]');
    if (!btn) return;
    dialog.close();
    await persist(api.post('/api/library', { appid: Number(btn.dataset.appid), name: btn.dataset.name }));
    await reload();
  });
}

// ---------- wiring ----------

const rowId = node => Number(node.closest('[data-appid]').dataset.appid);

function wireSortable() {
  Sortable.create(el.library.list, {
    handle: '.handle',
    animation: 150,
    filter: '.empty',
    onEnd: () => actions.reorder([...el.library.list.querySelectorAll('.lib-row')].map(li => Number(li.dataset.appid))),
  });
  Sortable.create(el.recs.list, {
    group: { name: 'recs', pull: true, put: false },
    sort: false,
    animation: 150,
    filter: '.empty, .rec-body',
    preventOnFilter: false,
    onStart: () => document.body.classList.add('dragging'),
    onEnd: () => document.body.classList.remove('dragging'),
  });
  for (const bucket of BUCKETS) {
    Sortable.create(el.recs.zones[bucket].querySelector('.zone-drop'), {
      group: { name: 'recs', pull: false, put: true },
      onAdd: evt => {
        const appid = Number(evt.item.dataset.appid);
        evt.item.remove();
        actions.triage(appid, bucket);
      },
    });
  }
}

function wireEvents() {
  $('#btn-import').addEventListener('click', () => actions.importSteam());
  $('#btn-regenerate').addEventListener('click', () => actions.regenerate());

  el.library.list.addEventListener('change', e => {
    if (e.target.dataset.action === 'seed') actions.setSeed(rowId(e.target), e.target.checked);
  });
  el.library.list.addEventListener('click', e => {
    if (e.target.dataset.action === 'hide') actions.setHidden(rowId(e.target), true);
  });
  el.library.hidden.addEventListener('click', e => {
    if (e.target.dataset.action === 'unhide') actions.setHidden(Number(e.target.dataset.appid), false);
  });

  el.recs.list.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    if (e.target.closest('[data-action="expand"]')) actions.toggleExpand(rowId(e.target));
  });
  for (const zone of Object.values(el.recs.zones)) {
    zone.addEventListener('click', e => {
      if (e.target.closest('[data-action="toggle-zone"]')) zone.classList.toggle('open');
      if (e.target.dataset.action === 'untriage') actions.untriage(Number(e.target.dataset.appid));
    });
  }

  el.tune.tags.addEventListener('input', e => {
    if (e.target.dataset.action !== 'slider') return;
    const tag = e.target.closest('[data-tag]').dataset.tag;
    const v = Number(e.target.value);
    e.target.nextElementSibling.textContent = v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0';
    const sliders = { ...state.settings.sliders, [tag]: v };
    if (v === 0) delete sliders[tag];
    actions.updateSettings({ sliders });
  });
  el.tune.tags.addEventListener('click', e => {
    if (e.target.dataset.action !== 'block') return;
    const tag = e.target.closest('[data-tag]').dataset.tag;
    const sliders = { ...state.settings.sliders };
    delete sliders[tag];
    actions.updateSettings({ blockedTags: [...state.settings.blockedTags, tag], sliders }, { tune: true });
  });
  el.tune.blocked.addEventListener('click', e => {
    if (e.target.dataset.action !== 'unblock-tag') return;
    actions.updateSettings({ blockedTags: state.settings.blockedTags.filter(t => t !== e.target.dataset.value) }, { tune: true });
  });
  el.tune.companies.addEventListener('click', e => {
    if (e.target.dataset.action !== 'unblock-company') return;
    actions.updateSettings({ blockedCompanies: state.settings.blockedCompanies.filter(c => c !== e.target.dataset.value) }, { tune: true });
  });
  $('#company-input').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const name = e.target.value.trim();
    if (!name) return;
    e.target.value = '';
    actions.updateSettings({ blockedCompanies: [...new Set([...state.settings.blockedCompanies, name])] }, { tune: true });
  });
  $('#tag-search').addEventListener('input', e => {
    state.tagQuery = e.target.value;
    render({ tune: true });
  });
  el.tune.form.addEventListener('change', () => actions.updateSettings(readFilters(el.tune.form)));
  el.tune.form.addEventListener('submit', e => e.preventDefault());
}

async function main() {
  wireSortable();
  wireEvents();
  wireAddDialog();
  await reload();
  if (state.catalog?.running) await pollCatalog();
}

main().catch(err => {
  state.notice = `Failed to load: ${err.message}`;
  renderStatus();
});
```

- [ ] **Step 8: Run the unit suite (nothing should regress)**

Run: `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 9: Browser check with seeded local data (no Steam key needed)**

Create a scratch seeding script outside the repo, then run it to populate a throwaway DB. In `<scratchpad>/seed-demo.mjs`:

```js
import { createStore } from 'C:/Users/justin.rhoda/steam.recs/lib/store.js';
const s = createStore(process.argv[2]);
s.importOwned([
  { appid: 1145360, name: 'Hades', hours: 140 },
  { appid: 646570, name: 'Slay the Spire', hours: 95 },
  { appid: 427520, name: 'Factorio', hours: 300 },
]);
const apps = [
  [1145360, 'Hades', { Roguelike: 900, Action: 700, 'Hack and Slash': 300 }],
  [646570, 'Slay the Spire', { 'Card Game': 900, Roguelike: 800, Deckbuilding: 700 }],
  [427520, 'Factorio', { Automation: 900, 'Base Building': 600, Strategy: 300 }],
  [588650, 'Dead Cells', { Roguelike: 800, Metroidvania: 700, Action: 600 }],
  [2379780, 'Balatro', { Deckbuilding: 900, 'Card Game': 800, Roguelike: 500 }],
  [526870, 'Satisfactory', { Automation: 900, 'Open World': 500, 'Base Building': 600 }],
  [367520, 'Hollow Knight', { Metroidvania: 900, Action: 500, "Souls-like": 400 }],
  [242760, 'The Forest', { Horror: 900, Survival: 800, 'Open World': 400 }],
];
apps.forEach(([appid, name, tags], i) => s.upsertApp({
  appid, name, tags, priceCents: 999 + i * 500, reviewPct: 0.8 + i * 0.02, reviewCount: 10000,
  releaseYear: 2015 + i, deckVerified: i % 2 === 0, modes: i % 3 === 0 ? ['single', 'coop'] : ['single'],
  tagsAt: Date.now(), detailsAt: Date.now(),
}));
s.setValue('candidateIds', [588650, 2379780, 526870, 367520, 242760]);
s.setValue('catalogFinishedAt', Date.now());
```

Run (PowerShell): `node <scratchpad>/seed-demo.mjs <scratchpad>/demo.db`, then `$env:DB_PATH='<scratchpad>/demo.db'; node server.js` in the background.

Open `http://localhost:3000` with the claude-in-chrome tools (or the webapp-testing skill) and verify each item, taking a screenshot of each state:
1. Three panels render. The banner says Steam is not configured, and "Import from Steam" is disabled.
2. The library shows 3 ranked games. Dragging Factorio to #1 reorders the list, and the top rec changes to Satisfactory. Reload the page: the order persists.
3. Clicking a rec card expands the breakdown, and its lines add up to the score shown.
4. Moving the "Roguelike" slider to +2 re-scores instantly with no network wait, and a "Roguelike boost" line appears. Reload: the slider is still +2.
5. Blocking "Horror" removes The Forest. Unblocking from the chip restores it.
6. Setting max price to `0` empties the list ("No games match"). Clearing the field restores it.
7. Dragging a rec onto "Not for me" removes it, and the count becomes 1. Opening the zone and clicking undo restores the rec.
8. Dragging a rec onto "Played" opens the rank dialog. Choosing rank 1 adds it to the top of the library.
9. "+ add game" searches the live store (needs internet): search "tunic", pick it, and it is appended to the library.
10. The browser console shows no errors.

Fix any defects found before committing, then stop the server.

- [ ] **Step 10: Commit**

```bash
git add public/index.html public/style.css public/api.js public/app.js public/ui/library.js public/ui/recs.js public/ui/tune.js
git commit -m "feat: add three-panel cockpit UI with drag-rank, triage, and tuning

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: README + live end-to-end check

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the whole app.

- [ ] **Step 1: Write `README.md`**

````markdown
# Steam Recs

A local web app that recommends Steam games based on the games you already play. You rank your library by dragging, tune tag weights, filters, and exclusions, and triage recommendations by dragging them into buckets. Every recommendation shows an itemized breakdown of its score.

## Setup

1. Install Node 24+.
2. `npm install`
3. Copy `.env.example` to `.env` and fill in:
   - `STEAM_API_KEY`: get one at https://steamcommunity.com/dev/apikey
   - `STEAM_ID`: your 17-digit SteamID64 (or your custom profile URL name)
   - `ANTHROPIC_API_KEY` (optional): enables Claude blurbs and ✨ wildcard picks on Regenerate
4. In Steam, go to Profile > Edit Profile > Privacy Settings and set **Game details** to **Public**. Without this, the import returns no games.

## Run

```
npm start
```

Open http://localhost:3000, click **Import from Steam**, then **Regenerate**. The first catalog build fetches tags and details for about 400 games while staying under Steam/SteamSpy rate limits, so it takes 10–20 minutes. Results appear while it runs. Cached data is reused for 7 days.

## How scoring works

- **Library rank:** #1 weighs 1.0 and the last game weighs 0.2. Playtime adds up to +0.25. Only games with ☑ (seeds) count.
- **Seed overlap:** each candidate is scored by how strongly its tags match your seeds' tags.
- **Tag sliders:** −2 to +2 suppress or boost a tag. ✕ blocks a tag entirely.
- **Triage:** "Interested" nudges similar games up; "Not for me" nudges them down. "Played" adds the game to your library at the rank you choose.
- **Review score:** a small nudge up or down relative to 70% positive.
- The top card is scaled to 100%, and the breakdown lines always add up to the score shown.

## Tests

```
npm test
```

## Data

Everything is stored in `steam-recs.db` (SQLite) in the project folder. Delete it to start over.
````

- [ ] **Step 2: Live check with real keys (needs Justin's `.env`)**

Ask Justin to create `.env` with real keys (do not read or print its contents). Then `npm start` and, in the browser:
1. Import from Steam. The library fills, sorted by hours, with the top 10 seeded.
2. Regenerate. The progress text counts up, and recs appear while it runs.
3. Spot-check 3 recs: does each breakdown cite sensible seed games?
4. If `ANTHROPIC_API_KEY` is set: after the build, blurbs appear in the expanded cards, and up to 3 ✨ wildcard cards appear.
5. Reload the page: no Claude call happens (check the server log or network tab), and the blurbs are still shown.

Report the results to Justin with screenshots. Note anything off as a follow-up rather than silently changing the scoring constants.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup, run, and scoring overview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
