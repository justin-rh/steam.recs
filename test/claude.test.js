import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeClient, buildPrompt, resolveWildcards, CLAUDE_MODEL, MAX_WILDCARDS } from '../lib/claude.js';

const input = {
  seeds: ['Hades', 'Slay the Spire'],
  topTags: ['Roguelike', 'Deckbuilding'],
  notForMe: ['Some Horror Game'],
  recs: [{ appid: 1, name: 'Dead Cells', tags: ['Roguelike'] }, { appid: 2, name: 'Balatro', tags: ['Deckbuilding'] }],
};

function fakeClient(response) {
  const requests = [];
  return {
    requests,
    beta: { messages: { create: async req => { requests.push(req); if (response instanceof Error) throw response; return response; } } },
  };
}

const textResponse = obj => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });

test('disabled without an API key', () => {
  assert.equal(createClaudeClient({ apiKey: '' }).enabled, false);
});

test('annotate sends model, low effort, fallback, schema; parses blurbs and caps wildcards', async () => {
  const client = fakeClient(textResponse({
    blurbs: [{ appid: 1, blurb: 'Fast runs like Hades.' }, { appid: 999, blurb: 'not requested' }],
    wildcards: [1, 2, 3, 4].map(i => ({ name: `W${i}`, blurb: `b${i}` })),
  }));
  const c = createClaudeClient({ apiKey: 'k', client });
  const out = await c.annotate(input);
  const req = client.requests[0];
  assert.equal(req.model, CLAUDE_MODEL);
  assert.equal(req.output_config.effort, 'low');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.deepEqual(out.blurbs, { 1: 'Fast runs like Hades.' });
  assert.equal(out.wildcards.length, MAX_WILDCARDS);
});

test('annotate throws on refusal', async () => {
  const c = createClaudeClient({ apiKey: 'k', client: fakeClient({ stop_reason: 'refusal', content: [] }) });
  await assert.rejects(c.annotate(input), /declined/);
});

test('annotate propagates API errors', async () => {
  const c = createClaudeClient({ apiKey: 'k', client: fakeClient(new Error('overloaded')) });
  await assert.rejects(c.annotate(input), /overloaded/);
});

test('buildPrompt includes seeds, tags, rejects, and candidate appids', () => {
  const p = buildPrompt(input);
  for (const s of ['Hades', 'Roguelike', 'Some Horror Game', '"appid": 1', 'Balatro']) assert.ok(p.includes(s), s);
});

test('resolveWildcards matches exact titles, then prefix, and drops excluded or unknown', async () => {
  const catalog = {
    'Outer Wilds': [{ appid: 10, name: 'Outer Wilds' }, { appid: 11, name: 'Outer Wilds - Echoes of the Eye' }],
    'Tunic': [{ appid: 20, name: 'TUNIC' }],
    'Owned Game': [{ appid: 30, name: 'Owned Game' }],
    'Nope': [],
    'Celeste': [{ appid: 40, name: 'Celeste Classic' }],
  };
  const search = async term => { if (term === 'Boom') throw new Error('down'); return catalog[term] || []; };
  const out = await resolveWildcards({
    wildcards: ['Outer Wilds', 'Tunic', 'Owned Game', 'Nope', 'Celeste', 'Boom'].map(name => ({ name, blurb: `why ${name}` })),
    search,
    excludeIds: new Set([30]),
  });
  assert.deepEqual(out, [
    { appid: 10, name: 'Outer Wilds', blurb: 'why Outer Wilds' },
    { appid: 20, name: 'TUNIC', blurb: 'why Tunic' },
    { appid: 40, name: 'Celeste Classic', blurb: 'why Celeste' },
  ]);
});
