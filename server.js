import { createApp } from './lib/app.js';
import { createStore } from './lib/store.js';
import { createSteamClient } from './lib/steam.js';
import { createSteamSpyClient } from './lib/steamspy.js';
import { createCatalog } from './lib/catalog.js';
import { createClaudeClient } from './lib/claude.js';
import { createThrottle } from './lib/throttle.js';

const store = createStore(process.env.DB_PATH || 'steam-recs.db');
const steam = createSteamClient({ apiKey: process.env.STEAM_API_KEY, steamId: process.env.STEAM_ID });
const catalog = createCatalog({
  store,
  steam,
  spy: createSteamSpyClient(),
  spyThrottle: createThrottle({ intervalMs: 1100 }),
  storeThrottle: createThrottle({ intervalMs: 1500 }),
});
const claude = createClaudeClient({ apiKey: process.env.ANTHROPIC_API_KEY });

const port = Number(process.env.PORT) || 3000;
createApp({ store, steam, catalog, claude }).listen(port, '127.0.0.1', () => {
  console.log(`Steam Recs running at http://localhost:${port}`);
  console.log(`Steam: ${steam.configured ? 'configured' : 'NOT configured (manual library only)'} | Claude: ${claude.enabled ? 'on' : 'off'}`);
});
