import { escapeHtml, capsuleFor, formatPrice, formatReview, formatSigned, topReason } from '../format.js';

export const BUCKETS = ['interested', 'not_for_me', 'played', 'hidden'];

function card(rec, { blurb, expanded }) {
  const a = rec.app;
  const deck = a.deckVerified ? ' · Deck ✓' : '';
  const body = expanded
    ? `<div class="rec-body">
        <table class="breakdown">${rec.lines.map(l =>
          `<tr><td>${escapeHtml(l.label)}</td><td class="${l.value < 0 ? 'neg' : 'pos'}">${formatSigned(l.value)}</td></tr>`).join('')}
          <tr><td><strong>Score</strong></td><td><strong>${rec.score}</strong></td></tr>
        </table>
        ${blurb ? `<p class="blurb">“${escapeHtml(blurb)}”${rec.pinned ? ' (Claude)' : ''}</p>` : ''}
        <a href="https://store.steampowered.com/app/${a.appid}/" target="_blank" rel="noopener">Open in Steam ↗</a>
      </div>`
    : '';
  return `<li class="rec${expanded ? ' open' : ''}" data-appid="${a.appid}">
    <div class="rec-head" data-action="expand">
      <img class="capsule" src="${escapeHtml(a.capsuleUrl || capsuleFor(a.appid))}" alt="" loading="lazy">
      <div>
        <div class="rec-title">${rec.pinned ? '<span class="wild" title="Claude wildcard pick">✨</span>' : ''}${escapeHtml(a.name)}</div>
        <div class="rec-reason">${escapeHtml(topReason(rec.lines))}</div>
        <div class="rec-meta">${formatPrice(a.priceCents)} · ${formatReview(a.reviewPct)} positive${deck}</div>
      </div>
      <div class="rec-score">${rec.score}%</div>
    </div>
    ${body}
  </li>`;
}

export function renderRecs(el, { recs, unscored, eligible, shown, blurbs, expanded, triage, catalogEmpty }) {
  el.list.innerHTML = recs.length
    ? recs.map(r => card(r, { blurb: blurbs[r.appid], expanded: expanded.has(r.appid) })).join('')
    : `<li class="empty">${catalogEmpty
      ? 'No catalog yet. Click Regenerate to build it (the first build takes about 45 minutes; results appear as they arrive).'
      : 'No games match your current filters.'}</li>`;
  const counts = [];
  if (recs.length) counts.push(`Showing ${shown} of ${eligible}`);
  if (unscored) counts.push(`${unscored} unscored (no tag data)`);
  el.unscored.textContent = counts.join(' · ');
  el.more.hidden = shown >= eligible;

  for (const bucket of BUCKETS) {
    const items = triage.filter(t => t.bucket === bucket);
    const zone = el.zones[bucket];
    zone.querySelector('.count').textContent = items.length;
    zone.querySelector('.zone-items').innerHTML = items.map(t =>
      `<li>${escapeHtml(t.name)} <button type="button" class="link" data-action="untriage" data-appid="${t.appid}">undo</button></li>`).join('')
      || '<li class="muted">Drag recommendations here</li>';
  }
}
