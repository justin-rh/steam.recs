import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyServerState } from '../public/state.js';
import { mergeSettings } from '../public/score.js';

const server = {
  config: { steamConfigured: true, claudeEnabled: false },
  library: [{ appid: 1, name: 'A', rank: 0, seed: true, hidden: false }],
  apps: [{ appid: 1, name: 'A', tags: { X: 1 } }],
  candidateIds: [2],
  triage: [],
  wishlist: [],
  settings: { sliders: {} },
  claude: null,
  catalog: { running: true },
};

test('applyServerState replaces data from the server', () => {
  const state = { settings: mergeSettings(), apps: new Map() };
  applyServerState(state, server, { settingsDirty: false });
  assert.equal(state.apps.get(1).name, 'A');
  assert.deepEqual(state.candidateIds, [2]);
  assert.deepEqual(state.settings.sliders, {});
});

test('applyServerState keeps unsaved local settings instead of reverting them', () => {
  const state = { settings: mergeSettings({ sliders: { Automation: 2 } }), apps: new Map() };
  applyServerState(state, server, { settingsDirty: true });
  assert.deepEqual(state.settings.sliders, { Automation: 2 });
  assert.deepEqual(state.candidateIds, [2]);
});
