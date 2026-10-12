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
    const current = getSettings();
    const merged = mergeSettings({ ...current, ...patch, filters: { ...current.filters, ...(patch.filters || {}) } });
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
