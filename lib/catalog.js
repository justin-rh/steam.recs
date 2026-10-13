import { buildProfile, tagIdf } from '../public/profile.js';

export const FRESH_MS = 7 * 24 * 3600 * 1000;
export const TOP_TAGS = 12;
export const PER_TAG = 50;
export const GEMS_PER_TAG = 60;
export const GEM_MIN_REVIEWS = 20;
export const GEM_MAX_REVIEWS = 20000;
export const GEM_MIN_RATIO = 0.8;

const Z = 1.96; // 95% confidence

// Lower bound of the Wilson score interval: "how positive is this game, at worst,
// given how few reviews it has". Stops 20/20 outranking 1,960/2,000.
export function wilsonLowerBound(positive, total) {
  if (!total) return 0;
  const p = positive / total;
  const z2 = Z * Z;
  return (p + z2 / (2 * total) - Z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / (1 + z2 / total);
}

// Well-reviewed games few people have played, so the obscurity slider has something to surface.
export function pickGems(list) {
  return list
    .map(r => ({ ...r, count: r.positive + r.negative }))
    .filter(r => r.count >= GEM_MIN_REVIEWS && r.count <= GEM_MAX_REVIEWS && r.positive / r.count >= GEM_MIN_RATIO)
    .map(r => ({ ...r, confidence: wilsonLowerBound(r.positive, r.count) }))
    .sort((a, b) => b.confidence - a.confidence || b.count - a.count)
    .slice(0, GEMS_PER_TAG);
}

export function createCatalog({ store, steam, spy, spyThrottle, storeThrottle, now = Date.now, log = console }) {
  const state = { running: false, phase: 'idle', done: 0, total: 0, failed: 0, error: null };
  const isFresh = ts => ts != null && now() - ts < FRESH_MS;

  async function ensureTags(appid) {
    const cur = store.getApp(appid);
    // languages == null means this app was cached before languages were tracked: refetch once.
    if (cur && isFresh(cur.tagsAt) && cur.languages != null) return cur;
    const d = await spyThrottle.run(() => spy.getAppDetails(appid));
    // [] marks "checked, SteamSpy had no language list" so it isn't refetched until stale.
    store.upsertApp({ ...(d || { appid }), languages: d?.languages ?? [], tagsAt: now() });
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

  // Tags (SteamSpy) and details (Steam store) come from different hosts with their own
  // rate limits, so run the two lanes side by side. An app is "done" once both lanes finish it.
  async function fetchAll(ids) {
    const remaining = new Map(ids.map(id => [id, 2]));
    const failed = new Set();
    const lane = async fetch => {
      for (const id of ids) {
        try {
          await fetch(id);
        } catch (err) {
          if (!failed.has(id)) {
            failed.add(id);
            state.failed++;
            log.warn?.(`catalog: app ${id} failed: ${err.message}`);
          }
        } finally {
          remaining.set(id, remaining.get(id) - 1);
          if (remaining.get(id) === 0) state.done++;
        }
      }
    };
    await Promise.all([lane(ensureTags), lane(ensureDetails)]);
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

  // Returns hidden gems first, then trending and popular picks, so obscure games
  // appear early in a long build.
  async function collectCandidates(topTags, ownedIds) {
    const gems = new Set();
    const popular = new Set();
    try {
      for (const r of await spyThrottle.run(() => spy.listTop2Weeks())) popular.add(r.appid);
      for (const tag of topTags) {
        const list = await spyThrottle.run(() => spy.listByTag(tag));
        pickGems(list).forEach(r => gems.add(r.appid));
        list.sort((a, b) => b.positive - a.positive).slice(0, PER_TAG).forEach(r => popular.add(r.appid));
      }
    } catch (err) {
      const cached = store.getValue('candidateIds', []);
      if (!cached.length) throw err;
      state.error = `Using cached candidate list (${err.message})`;
      cached.forEach(id => popular.add(id));
    }
    return [...new Set([...gems, ...popular])].filter(id => !ownedIds.has(id));
  }

  async function build() {
    const library = store.getLibrary().filter(g => !g.hidden);
    const seeded = library.filter(g => g.seed);
    setPhase('library', seeded.length);
    for (const g of seeded) await step(g.appid, () => ensureTags(g.appid));

    setPhase('lists', TOP_TAGS + 1);
    const known = store.getApps([...library.map(g => g.appid), ...store.getValue('candidateIds', [])]);
    const appsById = new Map(known.map(a => [a.appid, a]));
    const topTags = buildProfile(library, appsById, { idf: tagIdf(known) }).topTags.slice(0, TOP_TAGS);
    const ownedIds = new Set(store.getLibrary().map(g => g.appid));
    const candidates = await collectCandidates(topTags, ownedIds);
    store.setValue('candidateIds', candidates);

    setPhase('details', candidates.length);
    await fetchAll(candidates);

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
