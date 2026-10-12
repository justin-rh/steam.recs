import { isRetryable } from './http.js';

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createThrottle({ intervalMs, retries = 3, sleep = realSleep, now = Date.now }) {
  let chain = Promise.resolve();
  let last = -Infinity;

  async function gate() {
    const wait = last + intervalMs - now();
    if (wait > 0) await sleep(wait);
    last = now();
  }

  function run(fn) {
    const task = chain.then(async () => {
      for (let attempt = 0; ; attempt++) {
        await gate();
        try {
          return await fn();
        } catch (err) {
          if (attempt >= retries || !isRetryable(err)) throw err;
          await sleep(intervalMs * 2 ** (attempt + 1));
        }
      }
    });
    chain = task.catch(() => {});
    return task;
  }

  return { run };
}
