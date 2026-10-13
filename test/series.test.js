import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seriesKey, groupSeries } from '../public/series.js';

test('seriesKey strips subtitles, sequel numbers, Roman numerals, editions, a leading "The", and ™/®', () => {
  const cases = {
    'The Legend of Heroes: Trails in the Sky': 'legend of heroes',
    'The Legend of Heroes: Trails of Cold Steel': 'legend of heroes',
    'DARK SOULS™ III': 'dark souls',
    'Portal 2': 'portal',
    'Sid Meier’s Civilization® VI': 'sid meier s civilization',
    'Left 4 Dead 2': 'left 4 dead',
    'Spec Ops: The Line': 'spec ops',
    'Batman™: Arkham City - Game of the Year Edition': 'batman',
    'BioShock Remastered': 'bioshock',
    'Divinity: Original Sin 2 - Definitive Edition': 'divinity',
    'Hollow Knight': 'hollow knight',
    'Tales of ARISE': 'tales of arise',
    'XCOM 2': 'xcom',
  };
  for (const [name, key] of Object.entries(cases)) assert.equal(seriesKey(name), key, name);
});

test('seriesKey keeps meaningful leading numbers and never returns an empty key', () => {
  assert.equal(seriesKey('1979 Revolution: Black Friday'), '1979 revolution');
  assert.equal(seriesKey(': Untitled'), 'untitled');
  assert.equal(seriesKey('II'), 'ii');
});

const rec = (appid, name, developer, publisher = developer) => ({ appid, app: { appid, name, developer, publisher } });

test('groupSeries combines same-key games that share a developer or publisher, keeping order', () => {
  const groups = groupSeries([
    rec(1, 'Dark Souls III', 'FromSoftware', 'Bandai Namco'),
    rec(2, 'Hollow Knight', 'Team Cherry'),
    rec(3, 'DARK SOULS: REMASTERED', 'QLOC, FromSoftware', 'Bandai Namco'),
    rec(4, 'Dark Souls II', 'Someone Else', 'Bandai Namco'),
  ]);
  assert.deepEqual(groups.map(g => g.lead.appid), [1, 2]);
  assert.deepEqual(groups[0].others.map(r => r.appid), [3, 4]);
});

test('groupSeries keeps same-name games apart when no developer or publisher is shared', () => {
  const groups = groupSeries([
    rec(1, 'Star Wars: Squadrons', 'Motive', 'EA'),
    rec(2, 'Star Wars: Knights of the Old Republic', 'BioWare', 'Lucasfilm'),
  ]);
  assert.equal(groups.length, 2);
});

test('groupSeries treats missing company data as not shared', () => {
  const groups = groupSeries([rec(1, 'Portal', null, null), rec(2, 'Portal 2', null, null)]);
  assert.equal(groups.length, 2);
});
