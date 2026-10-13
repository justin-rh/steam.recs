import { fetchJson } from './http.js';

const SPY = 'https://steamspy.com/api.php';

const toListRow = r => ({
  appid: Number(r.appid),
  name: r.name,
  positive: Number(r.positive) || 0,
  negative: Number(r.negative) || 0,
});

const toList = data => Object.values(data || {}).map(toListRow).filter(r => r.appid > 0);

// "English, French,  Simplified Chinese" → ['English', 'French', 'Simplified Chinese'];
// blank or missing → null (unknown).
function parseLanguages(raw) {
  if (typeof raw !== 'string') return null;
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

export function createSteamSpyClient({ fetch: fetchImpl = globalThis.fetch } = {}) {
  async function getAppDetails(appid) {
    const d = await fetchJson(fetchImpl, `${SPY}?request=appdetails&appid=${appid}`);
    if (!d || !d.name) return null;
    const positive = Number(d.positive) || 0;
    const negative = Number(d.negative) || 0;
    const price = d.price === '' || d.price == null ? null : Number(d.price);
    return {
      appid,
      name: d.name,
      tags: d.tags && !Array.isArray(d.tags) ? d.tags : {},
      developer: d.developer || null,
      publisher: d.publisher || null,
      priceCents: Number.isFinite(price) ? price : null,
      reviewPct: positive + negative > 0 ? positive / (positive + negative) : null,
      reviewCount: positive + negative,
      languages: parseLanguages(d.languages),
    };
  }

  const listByTag = async tag => toList(await fetchJson(fetchImpl, `${SPY}?request=tag&tag=${encodeURIComponent(tag)}`));
  const listTop2Weeks = async () => toList(await fetchJson(fetchImpl, `${SPY}?request=top100in2weeks`));

  return { getAppDetails, listByTag, listTop2Weeks };
}
