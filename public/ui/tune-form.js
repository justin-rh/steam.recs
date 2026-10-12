// Pure conversion between the filter form and settings. `form` only needs
// .value / .checked on the named fields, so tests can pass plain objects.
function num(raw) {
  if (raw === '' || raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function readFilters(form) {
  const price = num(form.maxPrice.value);
  const pct = num(form.minReviewPct.value);
  const count = num(form.minReviewCount.value);
  const yearMin = num(form.yearMin.value);
  const yearMax = num(form.yearMax.value);
  return {
    filters: {
      maxPriceCents: price == null ? null : Math.round(price * 100),
      minReviewPct: pct == null ? null : Math.min(pct, 100) / 100,
      minReviewCount: count == null ? null : Math.round(count),
      yearMin: yearMin == null ? null : Math.round(yearMin),
      yearMax: yearMax == null ? null : Math.round(yearMax),
      deckOnly: Boolean(form.deckOnly.checked),
      mode: form.mode.value || 'any',
    },
    hideWishlisted: Boolean(form.hideWishlisted.checked),
    hideTriaged: Boolean(form.hideTriaged.checked),
    obscurity: Math.round(Number(form.obscurity.value)) || 0,
  };
}

export function writeFilters(form, settings) {
  const f = settings.filters;
  form.maxPrice.value = f.maxPriceCents == null ? '' : (f.maxPriceCents / 100).toFixed(2).replace(/\.00$/, '');
  form.minReviewPct.value = f.minReviewPct == null ? '' : String(Math.round(f.minReviewPct * 100));
  form.minReviewCount.value = f.minReviewCount == null ? '' : String(f.minReviewCount);
  form.yearMin.value = f.yearMin == null ? '' : String(f.yearMin);
  form.yearMax.value = f.yearMax == null ? '' : String(f.yearMax);
  form.deckOnly.checked = f.deckOnly;
  form.mode.value = f.mode;
  form.hideWishlisted.checked = settings.hideWishlisted;
  form.hideTriaged.checked = settings.hideTriaged;
  form.obscurity.value = String(settings.obscurity ?? 0);
}
