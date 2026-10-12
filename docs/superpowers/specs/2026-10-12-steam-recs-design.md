# Steam Recs — Design

**Date:** 2026-10-12
**Status:** Draft for review

## Goal

A local, single-user web app that recommends Steam games based on the games Justin already plays, with direct control over how recommendations are produced. Success: open the app, import the Steam library, drag games into a ranking, tune knobs, and get a list of unplayed games where every pick has a visible, itemized reason.

## Scope

**In scope**
- Library from the Steam Web API, plus manual add/remove/rerank
- Drag-and-drop **rank ordering** of library games (position = weight)
- Drag-and-drop **rec triage**: Interested / Not for me / Played, feeding back into scoring
- Knobs: seed games, tag weights (boost/suppress/block), filters, exclusions
- Hybrid engine: deterministic tag-similarity scoring; optional Claude blurbs + wildcard picks
- Three-panel "cockpit" UI with expandable score-breakdown cards

**Out of scope**
- Multiple users, auth, hosting/deployment
- Collaborative filtering ("players who played X also played Y")
- Purchasing, wishlisting via API, price-drop alerts

## Stack

Matches existing projects (`soti.api`, `simple.print`):
- Node + Express `server.js`, vanilla JS frontend in `public/`
- `better-sqlite3` for persistence (single file `steam-recs.db`)
- SortableJS for drag-and-drop (vendored into `public/vendor/`)
- `@anthropic-ai/sdk` for the optional Claude features, model `claude-sonnet-5-5`
- Node's built-in test runner (`node --test`)
- Config in `.env`: `STEAM_API_KEY`, `STEAM_ID` (SteamID64 or vanity name), optional `ANTHROPIC_API_KEY`, `PORT` (default 3000)

## Architecture

```
public/
  index.html, style.css, app.js     – cockpit UI
  score.js                          – pure ES module, shared with Node tests
  profile.js                        – pure ES module, shared with Node tests
  vendor/Sortable.min.js
server.js                           – Express routes, static serving
lib/
  steam.js     – GetOwnedGames, ResolveVanityURL, store search, appdetails
  catalog.js   – candidate pool from SteamSpy (top lists + per-genre), tag fetch, throttled queue
  claude.js    – blurbs for top N, wildcard suggestions, validation against catalog
  store.js     – SQLite schema + data access
test/
```

**Key decision:** scoring runs in the browser. The server sends the candidate pool (with tags, price, reviews, Deck status, release date) once. Every drag or slider change re-scores locally with no round-trip. `score.js` and `profile.js` are pure ES modules that are imported by both the browser and the Node tests.

### Data flow

1. **Import:** `POST /api/import` → Steam `GetOwnedGames` → upsert into `library`. Existing rank is preserved; new games are appended to the bottom.
2. **Catalog build:** `POST /api/catalog/refresh` → SteamSpy top-100-in-2-weeks, top-100-forever, and per-genre lists, plus library games → fetch tags/details per app via a throttled queue (~1 req/s) → cache in `apps`. Progress is exposed via `GET /api/catalog/status`. Entries are considered fresh for 7 days. Partial progress is saved, so a build resumes after interruption.
3. **Load:** `GET /api/state` → library (with rank, seed flag), settings, triage, candidate pool.
4. **Score (client):** `profile.js` builds a tag-affinity vector from seeded library games; `score.js` scores each candidate and returns `{appid, score, breakdown[]}` sorted.
5. **Claude (optional):** `POST /api/claude/annotate` with top 30 + profile summary → blurbs keyed by appid, plus up to 3 wildcard titles. Wildcards are resolved via store search to app IDs. Unresolvable, owned, or triaged ones are dropped. Resolved wildcards are fetched into `apps` so they can be scored and broken down like any other card.
6. **Writes:** rank reorder, seed toggle, triage, and settings changes are each a small `PUT`/`POST` that persists immediately.

## Scoring model

**Profile (`profile.js`)**
- Rank weight for library game at position `i` (0-based) of `n`: `w_rank = 1.0 - 0.8 * i / max(n-1, 1)` → #1 = 1.0, last = 0.2
- Playtime bonus: `w_play = 0.25 * log10(1 + hours) / log10(1 + maxHours)` (0 to 0.25)
- Game weight `w = w_rank + w_play`; only games with `seed = true` contribute
- Tag affinity: for each seed game, each of its tags gets `w * tagVoteShare`, where `tagVoteShare` = that tag's SteamSpy votes / the game's total tag votes. Affinities are summed across seeds and normalized so the max is 1.0.
- Each tag also remembers which seed games contributed most (used for the breakdown text).

**Score (`score.js`)**, per candidate:
1. **Hard excludes** (removed, not penalized): owned, in library, triaged (if "hide triaged" is on), wishlisted (if on), any blocked tag, blocked developer/publisher, fails any filter.
2. **Seed overlap:** for each candidate tag `t` with vote share `s`: `affinity[t] * s`. Contributions are grouped by the seed game that dominates each tag → breakdown lines such as "Hades (#1) overlap +41".
3. **Tag sliders:** for each candidate tag with slider value `v ∈ {-2..+2}`: `v * 0.15 * s` → "Roguelike boost +18".
4. **Triage feedback:** "Interested" games add `+0.05` per tag (by vote share) and "Not for me" games add `-0.05` per tag, aggregated into a per-tag adjustment → one line each.
5. **Quality nudge:** `+0.1 * (reviewPct - 0.7)` when review count ≥ the filter minimum → "Review score +3".
6. Final score = the sum of the lines, displayed as a 0–100 value: `round(100 * score / maxScoreInSet)`. The breakdown lines are scaled by the same factor so they **sum to the displayed score** (a tested invariant).

Defaults: top 10 library games seeded; all sliders 0; hide owned (forced), hide triaged on, hide wishlisted off.

## UI — three-panel cockpit

Top bar: title · Import from Steam · Regenerate (refresh catalog + Claude) · catalog freshness badge.

**Left — My Library**
- SortableJS list. Each row shows a drag handle, rank #, capsule thumbnail, name, hours, Seed checkbox, and ×.
- Reordering persists immediately and re-scores.
- "+ add game" opens a store-search popover to add a non-Steam-library game (`source = manual`).
- × marks a game `hidden` in the profile (not deleted, and restorable from a "Hidden" footer).

**Middle — Recommendations**
- The top 30 cards, sorted by score. Wildcards are badged ✨ and placed by their score.
- Collapsed card: capsule art, name, score %, one-line top reason, price, review %, Deck ✓.
- Expanded card (click): itemized breakdown lines, Claude blurb (if any), "Open in Steam" link.
- Three drop zones under the list: **Interested / Not for me / Played**, each with a count. Click a zone to list its games with an undo per game.
- Dropping into **Played** opens a small prompt: "Add to library at rank __" (default: bottom). The game is then inserted into the library and seeded.

**Right — Tune**
- **Tags:** searchable list (top 20 profile tags shown by default, search for any tag), each with a −2..+2 slider and a block ✕. Blocked tags are listed in a separate chip row.
- **Filters:** max price, min review %, min review count, release year range, Deck verified only, play mode (any / single-player / multiplayer / co-op).
- **Exclusions:** hide owned (locked on), hide wishlisted, hide triaged, blocked developers/publishers (chip input).
- Every control re-scores instantly. Settings persist with a short debounce (300 ms).

## Data model (SQLite)

```
library(appid PK, name, source['steam'|'manual'], hours, rank INT, seed BOOL, hidden BOOL)
apps(appid PK, name, tags_json, developer, publisher, price_cents, review_pct, review_count,
     release_year, deck_verified BOOL, modes_json, capsule_url, fetched_at)
triage(appid PK, bucket['interested'|'not_for_me'|'played'], created_at)
settings(key PK, value_json)
claude_cache(profile_hash PK, response_json, created_at)
```

Wishlist is read via `IWishlistService/GetWishlist` during import (if the profile allows it), and stored as `settings.wishlist`.

## Error handling

**Steam import**
- Missing `STEAM_API_KEY`/`STEAM_ID`: setup banner with instructions; the manual library still works.
- Empty `GetOwnedGames` response: "Set *Game details* to Public in Steam privacy settings" message.
- A non-numeric `STEAM_ID` is resolved via `ResolveVanityURL`. A failed resolve shows a clear error.

**Catalog / rate limits**
- SteamSpy and appdetails calls go through a ~1 req/s queue with backoff on 429/5xx (3 retries).
- First build shows a progress bar ("Fetching tags 120/400"). Partial results are saved, and the build resumes where it stopped.
- If an API fails, the app serves the stale cache with an age badge ("data from 9 days ago"). It never shows a blank screen because the cache is stale.
- Candidates with no tags are excluded from scoring and counted in an "N games unscored" note.

**Claude (optional)**
- No `ANTHROPIC_API_KEY`: ✨ features are hidden. Everything else works.
- Error or timeout (20 s): recs render without blurbs, plus a "Claude unavailable" notice.
- Responses are cached by a profile hash, so re-scoring never re-calls Claude. Only Regenerate does.
- Wildcards are validated against the store; invalid, owned, or triaged ones are dropped.

**Data safety**
- Every write is immediate; there is no save button.
- API keys stay server-side; the browser never receives them.

## Testing

- **TDD on pure modules** (`node --test`):
  - `profile.js`: rank decay endpoints (1.0 / 0.2), single-game library, playtime bonus bounds, unseeded games ignored, normalization.
  - `score.js`: each hard exclude, slider math, block removes, triage adjustments, quality nudge, sort order, **breakdown lines sum to the displayed score**.
- **Server routes:** `supertest` with mocked `steam`, `catalog`, and `claude` clients. Covers the private-profile, vanity resolve, 429 retry, stale-cache fallback, Claude-missing, and invalid-wildcard paths.
- **Live check before calling it done:** import the real library, rank games, and confirm the cards and breakdowns look sane in the browser.

## Repo

- Own git repo at `steam.recs/` (separate from the home-folder repo).
- `.gitignore`: `node_modules/`, `.env`, `*.db`, `.superpowers/`.
- `README.md` with setup (Steam API key, SteamID, privacy setting), run, and tests.
