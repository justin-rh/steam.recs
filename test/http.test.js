import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson, HttpError, isRetryable, redact } from '../lib/http.js';

const fakeFetch = (status, body, { json = true } = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => { if (!json) throw new SyntaxError('Unexpected token <'); return body; },
});

test('fetchJson returns parsed body on 200', async () => {
  assert.deepEqual(await fetchJson(fakeFetch(200, { a: 1 }), 'https://x.test/'), { a: 1 });
});

test('fetchJson throws HttpError with redacted key on non-2xx', async () => {
  await assert.rejects(fetchJson(fakeFetch(403, {}), 'https://x.test/?key=SECRET123&steamid=1'), err => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 403);
    assert.ok(!err.message.includes('SECRET123'));
    assert.ok(!err.url.includes('SECRET123'));
    return true;
  });
});

test('fetchJson surfaces an HTML error page as a retryable SyntaxError', async () => {
  await assert.rejects(fetchJson(fakeFetch(200, null, { json: false }), 'https://x.test/'), err => isRetryable(err));
});

test('isRetryable: 429 and 5xx yes, 404 no, network errors yes', () => {
  assert.equal(isRetryable(new HttpError(429, 'u')), true);
  assert.equal(isRetryable(new HttpError(503, 'u')), true);
  assert.equal(isRetryable(new HttpError(404, 'u')), false);
  assert.equal(isRetryable(new TypeError('fetch failed')), true);
});

test('redact hides key values anywhere in the query', () => {
  assert.equal(redact('https://a/?x=1&key=abc&y=2'), 'https://a/?x=1&key=REDACTED&y=2');
});
