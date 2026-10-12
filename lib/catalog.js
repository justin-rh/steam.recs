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
