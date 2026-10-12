const USER_AGENT = 'steam-recs/0.1 (personal, local use)';

export function redact(url) {
  return String(url).replace(/([?&]key=)[^&]*/gi, '$1REDACTED');
}

export class HttpError extends Error {
  constructor(status, url) {
    const safe = redact(url);
    super(`HTTP ${status} from ${safe}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = safe;
  }
}

export const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchJson(fetchImpl, url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json();
}

export function isRetryable(err) {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  return true;
}
