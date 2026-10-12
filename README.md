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
