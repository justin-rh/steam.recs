import { fetchJson } from './http.js';

const API = 'https://api.steampowered.com';
const STORE = 'https://store.steampowered.com';

// Store category ids → play modes used by the "play mode" filter.
const MODE_CATEGORIES = {
  2: 'single',
  1: 'multi', 36: 'multi', 47: 'multi', 49: 'multi',
  9: 'coop', 38: 'coop', 39: 'coop', 48: 'coop',
};

export class SteamError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SteamError';
    this.code = code;
  }
}

export const capsuleFor = appid => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_184x69.jpg`;

export function createSteamClient({ apiKey, steamId, fetch: fetchImpl = globalThis.fetch }) {
  const configured = Boolean(apiKey && steamId);
  let resolvedId = null;

  async function resolveSteamId() {
    if (!configured) throw new SteamError('missing_config', 'Steam is not configured. Add STEAM_API_KEY and STEAM_ID to .env and restart.');
    if (resolvedId) return resolvedId;
    if (/^\d{17}$/.test(steamId)) return (resolvedId = steamId);
    const data = await fetchJson(fetchImpl, `${API}/ISteamUser/ResolveVanityURL/v1/?key=${apiKey}&vanityurl=${encodeURIComponent(steamId)}`);
    if (data?.response?.success !== 1) {
      throw new SteamError('vanity_not_found', `Could not resolve Steam profile name "${steamId}". Put your 17-digit SteamID64 in STEAM_ID instead.`);
    }
    return (resolvedId = data.response.steamid);
  }

  async function getOwnedGames() {
    const id = await resolveSteamId();
    const data = await fetchJson(fetchImpl, `${API}/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${id}&include_appinfo=1&include_played_free_games=1`);
    const games = data?.response?.games;
    if (!Array.isArray(games) || games.length === 0) {
      throw new SteamError('private_profile', 'Steam returned no games. In Steam, open Profile > Edit Profile > Privacy Settings and set "Game details" to Public, then import again.');
    }
    return games.map(g => ({ appid: g.appid, name: g.name, hours: Math.round((g.playtime_forever || 0) / 6) / 10 }));
  }

  async function getWishlist() {
    try {
      const id = await resolveSteamId();
      const data = await fetchJson(fetchImpl, `${API}/IWishlistService/GetWishlist/v1/?steamid=${id}`);
      return (data?.response?.items || []).map(i => i.appid);
    } catch {
      return [];
    }
  }

  async function searchStore(term) {
    const data = await fetchJson(fetchImpl, `${STORE}/api/storesearch/?term=${encodeURIComponent(term)}&cc=US&l=en`);
    return (data?.items || [])
      .filter(i => !i.type || i.type === 'app')
      .map(i => ({ appid: i.id, name: i.name, capsuleUrl: i.tiny_image || capsuleFor(i.id) }));
  }

  async function getAppDetails(appid) {
    const data = await fetchJson(fetchImpl, `${STORE}/api/appdetails?appids=${appid}&cc=US&l=en`);
    const entry = data?.[appid];
    if (!entry?.success || !entry.data) return null;
    const d = entry.data;
    const year = Number((d.release_date?.date || '').match(/\b(19|20)\d{2}\b/)?.[0]) || null;
    const modes = [...new Set((d.categories || []).map(c => MODE_CATEGORIES[c.id]).filter(Boolean))];
    return {
      name: d.name,
      releaseYear: year,
      modes,
      priceCents: d.is_free ? 0 : d.price_overview?.final ?? null,
      capsuleUrl: d.capsule_image || capsuleFor(appid),
    };
  }

  async function getDeckVerified(appid) {
    const data = await fetchJson(fetchImpl, `${STORE}/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${appid}&l=english`);
    const category = data?.results?.resolved_category;
    return category == null ? null : category === 3;
  }

  return { configured, resolveSteamId, getOwnedGames, getWishlist, searchStore, getAppDetails, getDeckVerified };
}
