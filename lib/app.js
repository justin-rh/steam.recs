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
  if ('obscurity' in body) {
    if (!(isInt(body.obscurity) && body.obscurity >= -2 && body.obscurity <= 2)) throw new BadRequest('obscurity must be an integer from -2 to 2');
    out.obscurity = body.obscurity;
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
