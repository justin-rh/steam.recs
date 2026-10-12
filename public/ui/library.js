import { escapeHtml, capsuleFor } from '../format.js';

export function renderLibrary(el, { library, apps }) {
  const visible = library.filter(g => !g.hidden);
  const hidden = library.filter(g => g.hidden);

  el.list.innerHTML = visible.length
    ? visible.map((g, i) => {
      const thumb = apps.get(g.appid)?.capsuleUrl || capsuleFor(g.appid);
      return `<li class="lib-row" data-appid="${g.appid}">
        <span class="handle" title="Drag to rank">≡</span>
        <span class="rank">${i + 1}</span>
        <img class="thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy">
        <span class="name" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</span>
        <span class="hours">${g.hours ? `${g.hours}h` : ''}</span>
        <input type="checkbox" data-action="seed" title="Use as a seed" ${g.seed ? 'checked' : ''}>
        <button type="button" class="icon" data-action="hide" title="Hide from profile">×</button>
      </li>`;
    }).join('')
    : '<li class="empty">Import from Steam or add a game to start.</li>';

  el.hidden.innerHTML = hidden.length
    ? `<details><summary>Hidden (${hidden.length})</summary>${hidden.map(g =>
      `<div class="hidden-row">${escapeHtml(g.name)} <button type="button" class="link" data-action="unhide" data-appid="${g.appid}">restore</button></div>`).join('')}</details>`
    : '';
}
