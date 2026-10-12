// Pure display helpers. No DOM access at import time.
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const DAY_MS = 24 * 3600 * 1000;

export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ENTITIES[c]);

export const capsuleFor = appid => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_184x69.jpg`;

export function formatPrice(cents) {
  if (cents == null) return '—';
  if (cents === 0) return 'Free';
  return `$${(cents / 100).toFixed(2)}`;
}

export const formatReview = pct => (pct == null ? '—' : `${Math.round(pct * 100)}%`);

export function formatSigned(n) {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return '0';
}

export function topReason(lines) {
  const best = lines.filter(l => l.value > 0).sort((a, b) => b.value - a.value)[0];
  return best ? best.label : 'Matches your filters';
}

export function formatAge(ms) {
  const days = Math.floor(ms / DAY_MS);
  if (days < 1) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
