import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThrottle } from '../lib/throttle.js';
import { HttpError } from '../lib/http.js';

function fakeClock() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async ms => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

test('spaces consecutive calls by intervalMs and preserves order', async () => {
  const clock = fakeClock();
  const th = createThrottle({ intervalMs: 1000, ...clock });
  const order = [];
  const times = [];
  await Promise.all([1, 2, 3].map(n => th.run(async () => { order.push(n); times.push(clock.now()); return n; })));
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(times, [0, 1000, 2000]);
});

test('retries 429 with backoff then succeeds', async () => {
  const clock = fakeClock();
  const th = createThrottle({ intervalMs: 100, retries: 3, ...clock });
  let calls = 0;
  const result = await th.run(async () => { calls++; if (calls < 3) throw new HttpError(429, 'u'); return 'ok'; });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.ok(clock.sleeps.includes(200) && clock.sleeps.includes(400));
});

test('gives up after retries and rejects with the last error', async () => {
  const th = createThrottle({ intervalMs: 1, retries: 3, ...fakeClock() });
  let calls = 0;
  await assert.rejects(th.run(async () => { calls++; throw new HttpError(503, 'u'); }), /503/);
  assert.equal(calls, 4);
});

test('does not retry non-retryable errors, and later calls still run', async () => {
  const th = createThrottle({ intervalMs: 1, ...fakeClock() });
  let calls = 0;
  await assert.rejects(th.run(async () => { calls++; throw new HttpError(404, 'u'); }));
  assert.equal(calls, 1);
  assert.equal(await th.run(async () => 'next'), 'next');
});
