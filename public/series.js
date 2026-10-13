// Pure module: shared by the browser and Node tests. No DOM access.
// Steam has no "series" field, so series are inferred from titles plus a shared
// developer or publisher.

const EDITIONS = /\b(remastered|remaster|definitive edition|game of the year edition|goty edition|goty|complete edition|enhanced edition|deluxe edition|anniversary edition|director s cut|hd)\b/g;
const ROMAN = new Set(['ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx']);
const SUBTITLE = /:|\s[-–—]\s/;

const words = s => s.replace(/[^a-z0-9]+/g, ' ').trim();

// "The Legend of Heroes: Trails in the Sky" → "legend of heroes", "DARK SOULS™ III" → "dark souls".
export function seriesKey(name) {
  // Strip ™/®/© before NFKC, which would otherwise turn ™ into the letters "TM".
  const full = String(name ?? '').replace(/[™®©]/g, '').normalize('NFKC').toLowerCase();
  let head = full.split(SUBTITLE)[0];
  if (!words(head)) head = full.replace(/^[\s:–—-]+/, '').split(SUBTITLE)[0];
  const tokens = words(words(head).replace(EDITIONS, ' ')).split(' ').filter(Boolean);
  while (tokens.length > 1 && (/^\d+$/.test(tokens.at(-1)) || ROMAN.has(tokens.at(-1)))) tokens.pop();
  if (tokens.length > 1 && tokens[0] === 'the') tokens.shift();
  return tokens.join(' ') || words(full);
}

function companies(app) {
  return [app.developer, app.publisher]
    .filter(Boolean)
    .flatMap(s => String(s).split(','))
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

// recs must already be sorted best-first; each group's lead is its best game.
// Returns [{ lead, others }] in the order the leads first appear.
export function groupSeries(recs) {
  const groups = [];
  const byKey = new Map();
  for (const rec of recs) {
    const key = seriesKey(rec.app.name);
    const cos = companies(rec.app);
    const sameKey = byKey.get(key) || [];
    const group = sameKey.find(g => cos.some(c => g.companies.has(c)));
    if (group) {
      group.others.push(rec);
      cos.forEach(c => group.companies.add(c));
    } else {
      const created = { lead: rec, others: [], companies: new Set(cos) };
      groups.push(created);
      byKey.set(key, [...sameKey, created]);
    }
  }
  return groups.map(({ lead, others }) => ({ lead, others }));
}
