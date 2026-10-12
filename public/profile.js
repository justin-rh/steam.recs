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
