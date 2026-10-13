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

Open http://localhost:3000, click **Import from Steam**, then **Regenerate**. The first catalog build fetches tags and details for about 1,000 games while staying under Steam/SteamSpy rate limits, so it takes about 45 minutes. Hidden gems are fetched first, and results appear while it runs. Cached data is reused for 7 days, so later builds are much faster.

`npm start` runs Node with `--use-system-ca`, so it trusts the Windows certificate store. That's needed on networks that inspect HTTPS traffic (for example, CrowdStrike Falcon re-signs `api.anthropic.com`); without it, Claude calls fail with "Connection error".

## How scoring works

- **Library rank:** only games with ☑ (seeds) count. Your top seed weighs 1.0 and weight halves every 4 seeds (5th = 0.5, 9th = 0.25). Playtime multiplies a seed's weight by up to 1.25×.
- **Seed overlap:** each candidate is scored by how strongly its tags match your seeds' tags. Tags that appear on most games ("Singleplayer", "Indie") count for less than distinctive ones. Each card credits its top 3 contributing seeds, with the rest under "Other seeds".
- **Tag sliders:** −2 to +2 suppress or boost a tag. ✕ blocks a tag entirely.
- **Triage:** "Interested" nudges similar games up; "Not for me" nudges them down. "Played" adds the game to your library at the rank you choose.
- **Review score:** a small nudge up or down relative to 70% positive.
- **Obscurity slider:** −2 favors popular games, +2 favors games with few reviews.
- **Candidate pool:** for each of your top 12 tags, the 50 most-reviewed games plus up to 60 hidden gems (80%+ positive, 20–20,000 reviews, ranked by a confidence-adjusted rating), plus what's trending.
- The list shows 60 games; **Show more** adds 30 at a time.
- **English only** (Filters) hides games known not to support English. Language data comes from SteamSpy; games whose languages aren't known yet stay visible. The first Regenerate after upgrading fetches language data for your existing catalog (about 18 minutes, once).
- **Combine series** (Filters, on by default) shows each game series as one card led by its best match, with "+N more in series". Series are matched by title (ignoring subtitles, sequel numbers, and edition names) plus a shared developer or publisher. A series takes one slot in the list; triaging the shown game brings up the next one.
- The top card is scaled to 100%, and the breakdown lines always add up to the score shown.

## Tests

```
npm test
```

## Data

Everything is stored in `steam-recs.db` (SQLite) in the project folder. Delete it to start over.
