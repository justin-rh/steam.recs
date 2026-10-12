import Anthropic from '@anthropic-ai/sdk';

export const CLAUDE_MODEL = 'claude-opus-5-5';
export const MAX_WILDCARDS = 3;

const SYSTEM = `You help one player find their next PC game on Steam.
You receive the player's favorite games (most important first), their strongest tag preferences, games they rejected, and a list of candidates a scoring engine already picked.
1. For each candidate, write one sentence (at most 25 words) on why this player in particular would enjoy it. Refer to their favorites where it fits. Do not restate the game's name or list its tags.
2. Suggest exactly 3 wildcard games that are sold on Steam, are not among the candidates or favorites, and that a tag-matching engine would likely miss, such as standouts from adjacent genres. Use each game's exact Steam store title and give it a one-sentence blurb in the same style.`;

const SCHEMA = {
  type: 'object',
  properties: {
    blurbs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { appid: { type: 'integer' }, blurb: { type: 'string' } },
        required: ['appid', 'blurb'],
        additionalProperties: false,
      },
    },
    wildcards: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, blurb: { type: 'string' } },
        required: ['name', 'blurb'],
        additionalProperties: false,
      },
    },
  },
  required: ['blurbs', 'wildcards'],
  additionalProperties: false,
};

export function buildPrompt({ seeds, topTags, notForMe, recs }) {
  return [
    `Favorite games, most important first: ${seeds.join(', ') || '(none yet)'}`,
    `Strongest tag preferences: ${topTags.join(', ') || '(none yet)'}`,
    `Rejected ("not for me"): ${notForMe.join(', ') || '(none)'}`,
    'Candidates:',
    JSON.stringify(recs, null, 1),
  ].join('\n');
}

export function createClaudeClient({ apiKey, client = apiKey ? new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 }) : null }) {
  async function annotate(input) {
    if (!client) throw new Error('Claude is not configured');
    const response = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: buildPrompt(input) }],
    });
    if (response.stop_reason === 'refusal') throw new Error('Claude declined the request');
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed = JSON.parse(text);
    const requested = new Set(input.recs.map(r => r.appid));
    const blurbs = Object.fromEntries(parsed.blurbs.filter(b => requested.has(b.appid)).map(b => [b.appid, b.blurb]));
    return { blurbs, wildcards: parsed.wildcards.slice(0, MAX_WILDCARDS) };
  }

  return { enabled: Boolean(client), annotate };
}

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

export async function resolveWildcards({ wildcards, search, excludeIds }) {
  const out = [];
  for (const w of wildcards) {
    let results;
    try {
      results = await search(w.name);
    } catch {
      continue;
    }
    const target = norm(w.name);
    const match = results.find(r => norm(r.name) === target) || results.find(r => norm(r.name).startsWith(target));
    if (!match || excludeIds.has(match.appid) || out.some(o => o.appid === match.appid)) continue;
    out.push({ appid: match.appid, name: match.name, blurb: w.blurb });
  }
  return out;
}
