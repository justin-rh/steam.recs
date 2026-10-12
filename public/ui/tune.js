import { escapeHtml, formatSigned } from '../format.js';
import { writeFilters } from './tune-form.js';

const chip = (label, action) =>
  `<span class="chip">${escapeHtml(label)} <button type="button" class="icon" data-action="${action}" data-value="${escapeHtml(label)}" title="Remove">✕</button></span>`;

export function renderTune(el, { settings, topTags, allTags, tagQuery }) {
  const blocked = new Set(settings.blockedTags);
  const q = tagQuery.trim().toLowerCase();
  const tags = q
    ? allTags.filter(t => t.toLowerCase().includes(q) && !blocked.has(t)).slice(0, 30)
    : topTags.filter(t => !blocked.has(t)).slice(0, 20);

  el.tags.innerHTML = tags.map(t => {
    const v = settings.sliders[t] || 0;
    return `<li class="tag-row" data-tag="${escapeHtml(t)}">
      <span class="tag-name" title="${escapeHtml(t)}">${escapeHtml(t)}</span>
      <input type="range" min="-2" max="2" step="1" value="${v}" data-action="slider" aria-label="Weight for ${escapeHtml(t)}">
      <span class="tag-val">${formatSigned(v)}</span>
      <button type="button" class="icon" data-action="block" title="Block this tag">✕</button>
    </li>`;
  }).join('') || '<li class="empty">No matching tags</li>';

  el.blocked.innerHTML = settings.blockedTags.map(t => chip(t, 'unblock-tag')).join('') || '<span class="muted">None</span>';
  el.companies.innerHTML = settings.blockedCompanies.map(c => chip(c, 'unblock-company')).join('');
  writeFilters(el.form, settings);
  el.obscurityVal.textContent = formatSigned(settings.obscurity ?? 0);
}
