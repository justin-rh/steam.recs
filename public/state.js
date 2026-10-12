// Pure: copies a /api/state payload into the browser state object.
import { mergeSettings } from './score.js';

// settingsDirty: the user has a settings change that is not yet saved. Keep it,
// so a background reload (e.g. during a catalog build) can't revert the change.
export function applyServerState(state, s, { settingsDirty }) {
  state.config = s.config;
  state.library = s.library;
  state.apps = new Map(s.apps.map(a => [a.appid, a]));
  state.candidateIds = s.candidateIds;
  state.triage = s.triage;
  state.wishlist = s.wishlist;
  if (!settingsDirty) state.settings = mergeSettings(s.settings);
  state.claude = s.claude;
  state.catalog = s.catalog;
  return state;
}
