// Pure module: shared by the browser and Node tests. No DOM access.

// A seed's weight halves every RANK_HALF_LIFE seeds: #1 = 1.0, #5 = 0.5, #9 = 0.25.
export const RANK_HALF_LIFE = 4;
export const PLAY_BONUS_MAX = 0.25;

// seedIndex is the 0-based position among seeded games (not the whole library),
// so a long library doesn't flatten the differences between your top picks.
export function rankWeight(seedIndex) {
  return 0.5 ** (seedIndex / RANK_HALF_LIFE);
}

// Playtime scales a seed's weight by up to 1.25×. Multiplying (instead of adding)
// means hours can't lift a low-ranked game past a high-ranked one.
export function playMultiplier(hours, maxHours) {
  if (!maxHours || maxHours <= 0) return 1;
  return 1 + PLAY_BONUS_MAX * Math.log10(1 + hours) / Math.log10(1 + maxHours);
}

export function voteShares(tags) {
  const entries = Object.entries(tags || {}).filter(([, v]) => Number(v) > 0);
  const total = entries.reduce((sum, [, v]) => sum + Number(v), 0);
  if (total <= 0) return {};
  return Object.fromEntries(entries.map(([tag, v]) => [tag, Number(v) / total]));
}

// Inverse document frequency over a set of apps: tags on nearly every game
// ("Singleplayer", "Indie") get ~1, rare tags up to ~2-3x more. The square root
// dampens the boost so a tag only a low-ranked seed has can't take over.
export function tagIdf(apps) {
  const df = {};
  let n = 0;
  for (const app of apps) {
    const tags = Object.keys(app?.tags || {});
    if (!tags.length) continue;
    n++;
    for (const t of tags) df[t] = (df[t] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(df).map(([t, d]) => [t, Math.sqrt(Math.log((n + 1) / (d + 1)) + 1)]));
}

export function buildProfile(library, appsById, { idf = {} } = {}) {
  const visible = library.filter(g => !g.hidden).sort((a, b) => a.rank - b.rank);
  const seeded = visible.map((g, i) => ({ ...g, displayRank: i + 1 })).filter(g => g.seed);
  const maxHours = Math.max(0, ...seeded.map(g => g.hours || 0));
  const raw = {};
  const sources = {};
  const seeds = [];

  seeded.forEach((g, seedIndex) => {
    const rank = g.displayRank;
    const weight = rankWeight(seedIndex) * playMultiplier(g.hours || 0, maxHours);
    seeds.push({ appid: g.appid, name: g.name, rank, weight });
    for (const [tag, share] of Object.entries(voteShares(appsById.get(g.appid)?.tags))) {
      const contribution = weight * share;
      raw[tag] = (raw[tag] || 0) + contribution;
      (sources[tag] ||= []).push({ appid: g.appid, name: g.name, rank, contribution });
    }
  });

  for (const tag of Object.keys(raw)) {
    const total = raw[tag];
    for (const s of sources[tag]) s.frac = s.contribution / total;
    sources[tag].sort((a, b) => b.contribution - a.contribution);
    raw[tag] *= idf[tag] ?? 1;
  }

  const max = Math.max(0, ...Object.values(raw));
  const affinity = {};
  for (const [tag, v] of Object.entries(raw)) affinity[tag] = max > 0 ? v / max : 0;
  const topTags = Object.keys(affinity).sort((a, b) => affinity[b] - affinity[a] || a.localeCompare(b));
  return { affinity, sources, topTags, seeds };
}
