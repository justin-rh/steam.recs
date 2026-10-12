import { api } from './api.js';
import { buildProfile } from './profile.js';
import { scoreCandidates, mergeSettings } from './score.js';
import { renderLibrary } from './ui/library.js';
import { renderRecs, BUCKETS } from './ui/recs.js';
import { renderTune } from './ui/tune.js';
import { readFilters } from './ui/tune-form.js';
import { escapeHtml, formatAge, capsuleFor } from './format.js';

const $ = sel => document.querySelector(sel);
const POLL_MS = 2000;
const RELOAD_EVERY_POLLS = 5;
const SAVE_DEBOUNCE_MS = 300;

const state = {
  config: {}, library: [], apps: new Map(), candidateIds: [], triage: [], wishlist: [],
  settings: mergeSettings(), claude: null, catalog: null,
  expanded: new Set(), tagQuery: '', notice: null, busy: null,
};

const el = {
  banner: $('#banner'),
  status: $('#catalog-status'),
  tunePanel: $('#tune'),
  library: { list: $('#library-list'), hidden: $('#library-hidden') },
  recs: { list: $('#rec-list'), unscored: $('#unscored'), zones: Object.fromEntries(BUCKETS.map(b => [b, $(`#zone-${b}`)])) },
  tune: { tags: $('#tag-list'), blocked: $('#blocked-tags'), companies: $('#blocked-companies'), form: $('#filters') },
};

// ---------- state ----------

function hydrate(s) {
  state.config = s.config;
  state.library = s.library;
  state.apps = new Map(s.apps.map(a => [a.appid, a]));
  state.candidateIds = s.candidateIds;
  state.triage = s.triage;
  state.wishlist = s.wishlist;
  state.settings = mergeSettings(s.settings);
  state.claude = s.claude;
  state.catalog = s.catalog;
}

async function reload() {
  hydrate(await api.get('/api/state'));
  // 'auto' leaves the Tune panel alone while the user is interacting with it
  // (e.g. mid-slider-drag during a background catalog poll).
  render();
}

function compute() {
  const profile = buildProfile(state.library, state.apps);
  const wildcardIds = new Set((state.claude?.wildcards || []).map(w => w.appid));
  const ids = [...new Set([...state.candidateIds, ...wildcardIds])];
  const candidates = ids.map(id => state.apps.get(id)).filter(Boolean);
  const result = scoreCandidates({
    profile,
    candidates,
    settings: state.settings,
    pinnedIds: wildcardIds,
    ctx: {
      excludeIds: new Set(state.library.map(g => g.appid)),
      wishlistIds: new Set(state.wishlist),
      triage: state.triage.map(t => ({ ...t, tags: state.apps.get(t.appid)?.tags })),
    },
  });
  const allTags = [...new Set([...state.apps.values()].flatMap(a => Object.keys(a.tags || {})))].sort();
  return { profile, allTags, ...result };
}

// ---------- rendering ----------

function render({ tune = 'auto' } = {}) {
  const r = compute();
  renderLibrary(el.library, { library: state.library, apps: state.apps });
  renderRecs(el.recs, {
    recs: r.recs,
    unscored: r.unscored,
    blurbs: state.claude?.blurbs || {},
    expanded: state.expanded,
    triage: state.triage.map(t => ({ ...t, name: state.apps.get(t.appid)?.name ?? `App ${t.appid}` })),
    catalogEmpty: state.candidateIds.length === 0,
  });
  const tuneFocused = el.tunePanel.contains(document.activeElement);
  if (tune === true || (tune === 'auto' && !tuneFocused)) {
    renderTune(el.tune, { settings: state.settings, topTags: r.profile.topTags, allTags: r.allTags, tagQuery: state.tagQuery });
  }
  renderStatus();
  return r;
}

function renderStatus() {
  const c = state.catalog;
  let text;
  if (state.busy) text = state.busy;
  else if (c?.running) text = `Building catalog: ${c.phase} ${c.done}/${c.total}${c.failed ? ` (${c.failed} failed)` : ''}`;
  else if (c?.finishedAt) text = `${c.candidateCount} candidates · data from ${formatAge(Date.now() - c.finishedAt)}${c.failed ? ` · ${c.failed} failed` : ''}`;
  else text = 'No catalog yet';
  if (c?.error) text += ` · ${c.error}`;
  el.status.textContent = text;
  el.status.classList.toggle('stale', Boolean(c?.stale));

  const msgs = [];
  if (!state.config.steamConfigured) msgs.push('Steam is not configured: add STEAM_API_KEY and STEAM_ID to .env and restart. You can still add games by hand.');
  if (state.notice) msgs.push(state.notice);
  el.banner.innerHTML = msgs.map(m => `<p>${escapeHtml(m)}</p>`).join('');
  el.banner.hidden = msgs.length === 0;
  $('#btn-import').disabled = !state.config.steamConfigured;
}

// ---------- persistence ----------

async function persist(promise) {
  try {
    return await promise;
  } catch (err) {
    state.notice = err.message;
    await reload();
    return null;
  }
}

let saveTimer = null;
function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { sliders, blockedTags, blockedCompanies, filters, hideWishlisted, hideTriaged } = state.settings;
    persist(api.put('/api/settings', { sliders, blockedTags, blockedCompanies, filters, hideWishlisted, hideTriaged }));
  }, SAVE_DEBOUNCE_MS);
}

// ---------- actions ----------

const actions = {
  reorder(appids) {
    const byId = new Map(state.library.map(g => [g.appid, g]));
    const listed = new Set(appids);
    const rest = state.library.filter(g => !listed.has(g.appid));
    state.library = [...appids.map(id => byId.get(id)), ...rest].map((g, i) => ({ ...g, rank: i }));
    render({ tune: true });
    persist(api.put('/api/library/order', { appids }));
  },

  setSeed(appid, seed) {
    state.library = state.library.map(g => (g.appid === appid ? { ...g, seed } : g));
    render({ tune: true });
    persist(api.patch(`/api/library/${appid}`, { seed }));
  },

  setHidden(appid, hidden) {
    state.library = state.library.map(g => (g.appid === appid ? { ...g, hidden } : g));
    render({ tune: true });
    persist(api.patch(`/api/library/${appid}`, { hidden }));
  },

  triage(appid, bucket) {
    if (bucket === 'played') return openPlayedDialog(appid);
    state.triage = [...state.triage.filter(t => t.appid !== appid), { appid, bucket }];
    render();
    persist(api.put(`/api/triage/${appid}`, { bucket }));
  },

  untriage(appid) {
    state.triage = state.triage.filter(t => t.appid !== appid);
    render();
    persist(api.del(`/api/triage/${appid}`));
  },

  toggleExpand(appid) {
    if (state.expanded.has(appid)) state.expanded.delete(appid);
    else state.expanded.add(appid);
    render();
  },

  updateSettings(patch, { tune = 'auto' } = {}) {
    state.settings = mergeSettings({ ...state.settings, ...patch });
    render({ tune });
    saveSettingsSoon();
  },

  async importSteam() {
    state.busy = 'Importing from Steam…';
    renderStatus();
    try {
      const r = await api.post('/api/import');
      state.notice = `Imported from Steam: ${r.added} new, ${r.updated} updated.`;
    } catch (err) {
      state.notice = err.message;
    }
    state.busy = null;
    await reload();
  },

  async regenerate() {
    state.notice = null;
    try {
      await api.post('/api/catalog/refresh');
    } catch (err) {
      if (err.status !== 409) { state.notice = err.message; renderStatus(); return; }
    }
    await pollCatalog();
    await askClaude();
  },
};

async function pollCatalog() {
  for (let i = 1; ; i++) {
    state.catalog = await api.get('/api/catalog/status');
    renderStatus();
    if (!state.catalog.running) break;
    if (i % RELOAD_EVERY_POLLS === 0) await reload();
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  await reload();
}

async function askClaude() {
  if (!state.config.claudeEnabled) return;
  const { recs } = compute();
  state.busy = 'Asking Claude for blurbs and wildcards…';
  renderStatus();
  try {
    const res = await api.post('/api/claude/annotate', { appids: recs.filter(r => !r.pinned).map(r => r.appid) });
    if (res.error) state.notice = res.error;
  } catch (err) {
    state.notice = `Claude unavailable: ${err.message}`;
  }
  state.busy = null;
  await reload();
}

// ---------- dialogs ----------

function openPlayedDialog(appid) {
  const dialog = $('#played-dialog');
  const name = state.apps.get(appid)?.name ?? `App ${appid}`;
  const visibleCount = state.library.filter(g => !g.hidden).length;
  $('#played-name').textContent = name;
  const rankInput = $('#played-rank');
  rankInput.max = String(visibleCount + 1);
  rankInput.value = String(visibleCount + 1);
  dialog.returnValue = '';
  dialog.onclose = async () => {
    if (dialog.returnValue !== 'ok') { render(); return; }
    const rank = Math.max(1, Math.min(Number(rankInput.value) || visibleCount + 1, visibleCount + 1));
    const visible = state.library.filter(g => !g.hidden);
    const before = visible[rank - 1];
    const position = before ? state.library.findIndex(g => g.appid === before.appid) : state.library.length;
    await persist(api.post('/api/library', { appid, name, position }));
    await persist(api.put(`/api/triage/${appid}`, { bucket: 'played' }));
    await reload();
  };
  dialog.showModal();
}

let searchTimer = null;
function wireAddDialog() {
  const dialog = $('#add-dialog');
  const input = $('#add-search');
  const results = $('#add-results');
  $('#btn-add').addEventListener('click', () => {
    input.value = '';
    results.innerHTML = '';
    dialog.showModal();
    input.focus();
  });
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      try {
        const { results: items } = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
        results.innerHTML = items.slice(0, 15).map(i => `<li><button type="button" data-appid="${i.appid}" data-name="${escapeHtml(i.name)}">
          <img src="${escapeHtml(i.capsuleUrl || capsuleFor(i.appid))}" alt="">${escapeHtml(i.name)}</button></li>`).join('')
          || '<li class="muted">No results</li>';
      } catch (err) {
        results.innerHTML = `<li class="muted">${escapeHtml(err.message)}</li>`;
      }
    }, SAVE_DEBOUNCE_MS);
  });
  results.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-appid]');
    if (!btn) return;
    dialog.close();
    await persist(api.post('/api/library', { appid: Number(btn.dataset.appid), name: btn.dataset.name }));
    await reload();
  });
}

// ---------- wiring ----------

const rowId = node => Number(node.closest('[data-appid]').dataset.appid);

function wireSortable() {
  Sortable.create(el.library.list, {
    handle: '.handle',
    animation: 150,
    forceFallback: true,
    filter: '.empty',
    onEnd: () => actions.reorder([...el.library.list.querySelectorAll('.lib-row')].map(li => Number(li.dataset.appid))),
  });
  Sortable.create(el.recs.list, {
    group: { name: 'recs', pull: true, put: false },
    sort: false,
    animation: 150,
    forceFallback: true,
    filter: '.empty, .rec-body',
    preventOnFilter: false,
    onStart: () => document.body.classList.add('dragging'),
    onEnd: () => document.body.classList.remove('dragging'),
  });
  for (const bucket of BUCKETS) {
    Sortable.create(el.recs.zones[bucket].querySelector('.zone-drop'), {
      group: { name: 'recs', pull: false, put: true },
      onAdd: evt => {
        const appid = Number(evt.item.dataset.appid);
        evt.item.remove();
        actions.triage(appid, bucket);
      },
    });
  }
}

function wireEvents() {
  $('#btn-import').addEventListener('click', () => actions.importSteam());
  $('#btn-regenerate').addEventListener('click', () => actions.regenerate());

  el.library.list.addEventListener('change', e => {
    if (e.target.dataset.action === 'seed') actions.setSeed(rowId(e.target), e.target.checked);
  });
  el.library.list.addEventListener('click', e => {
    if (e.target.dataset.action === 'hide') actions.setHidden(rowId(e.target), true);
  });
  el.library.hidden.addEventListener('click', e => {
    if (e.target.dataset.action === 'unhide') actions.setHidden(Number(e.target.dataset.appid), false);
  });

  el.recs.list.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    if (e.target.closest('[data-action="expand"]')) actions.toggleExpand(rowId(e.target));
  });
  for (const zone of Object.values(el.recs.zones)) {
    zone.addEventListener('click', e => {
      if (e.target.closest('[data-action="toggle-zone"]')) zone.classList.toggle('open');
      if (e.target.dataset.action === 'untriage') actions.untriage(Number(e.target.dataset.appid));
    });
  }

  el.tune.tags.addEventListener('input', e => {
    if (e.target.dataset.action !== 'slider') return;
    const tag = e.target.closest('[data-tag]').dataset.tag;
    const v = Number(e.target.value);
    e.target.nextElementSibling.textContent = v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0';
    const sliders = { ...state.settings.sliders, [tag]: v };
    if (v === 0) delete sliders[tag];
    actions.updateSettings({ sliders });
  });
  el.tune.tags.addEventListener('click', e => {
    if (e.target.dataset.action !== 'block') return;
    const tag = e.target.closest('[data-tag]').dataset.tag;
    const sliders = { ...state.settings.sliders };
    delete sliders[tag];
    actions.updateSettings({ blockedTags: [...state.settings.blockedTags, tag], sliders }, { tune: true });
  });
  el.tune.blocked.addEventListener('click', e => {
    if (e.target.dataset.action !== 'unblock-tag') return;
    actions.updateSettings({ blockedTags: state.settings.blockedTags.filter(t => t !== e.target.dataset.value) }, { tune: true });
  });
  el.tune.companies.addEventListener('click', e => {
    if (e.target.dataset.action !== 'unblock-company') return;
    actions.updateSettings({ blockedCompanies: state.settings.blockedCompanies.filter(c => c !== e.target.dataset.value) }, { tune: true });
  });
  $('#company-input').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const name = e.target.value.trim();
    if (!name) return;
    e.target.value = '';
    actions.updateSettings({ blockedCompanies: [...new Set([...state.settings.blockedCompanies, name])] }, { tune: true });
  });
  $('#tag-search').addEventListener('input', e => {
    state.tagQuery = e.target.value;
    render({ tune: true });
  });
  el.tune.form.addEventListener('change', () => actions.updateSettings(readFilters(el.tune.form)));
  el.tune.form.addEventListener('submit', e => e.preventDefault());
}

async function main() {
  wireSortable();
  wireEvents();
  wireAddDialog();
  await reload();
  if (state.catalog?.running) await pollCatalog();
}

main().catch(err => {
  state.notice = `Failed to load: ${err.message}`;
  renderStatus();
});
