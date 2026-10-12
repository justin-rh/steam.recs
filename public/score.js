// Pure module: shared by the browser and Node tests. No DOM access.
import { voteShares } from './profile.js';

export const SLIDER_STEP = 0.15;
export const TRIAGE_STEP = 0.05;
export const QUALITY_STEP = 0.1;
export const QUALITY_PIVOT = 0.7;
export const DEFAULT_LIMIT = 60;
export const OBSCURITY_STEP = 0.25;
// log10 of a review count that counts as "not obscure at all" (1,000,000).
const OBSCURITY_LOG_CEILING = 6;

// 0..1, where 1 is most obscure. 10 reviews ≈ 0.83, 1,000 ≈ 0.5, 1M → 0.
export function obscurityOf(reviewCount) {
  if (reviewCount == null) return null;
  return Math.min(1, Math.max(0, 1 - Math.log10(1 + reviewCount) / OBSCURITY_LOG_CEILING));
}

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
  obscurity: 0,
});

export const SETTING_KEYS = ['sliders', 'blockedTags', 'blockedCompanies', 'filters', 'hideWishlisted', 'hideTriaged', 'obscurity'];

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
  if (ctx.hiddenIds?.has(app.appid)) return 'hidden';
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
  const obscurity = obscurityOf(app.reviewCount);
  if (settings.obscurity && obscurity != null) {
    lines.push({
      label: settings.obscurity > 0 ? 'Prefers obscure' : 'Prefers popular',
      kind: 'obscurity',
      value: settings.obscurity * OBSCURITY_STEP * (2 * obscurity - 1),
    });
  }
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
  const fullCtx = {
    excludeIds: ctx.excludeIds,
    wishlistIds: ctx.wishlistIds,
    triagedIds: new Set(ctx.triage.map(t => t.appid)),
    // Hidden is "never show me this", independent of the hideTriaged toggle.
    hiddenIds: new Set(ctx.triage.filter(t => t.bucket === 'hidden').map(t => t.appid)),
  };
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
  return { recs, unscored, eligible: scored.length, shown: top.length };
}
