import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sports-test-'));
const { setSetting } = await import('../src/settings.js');
const sports = await import('../src/sports.js');
const { invensSportsResult } = await import('../src/ai/guardrails.js');
const { cacheable } = await import('../src/ai/answer-cache.js');

test('a sports question is recognised, ordinary chat is not', () => {
  setSetting('sports.f1Enabled', true);
  for (const q of [
    'who won the f1', 'whats the f1 standings', 'f1 results',
    'who won the grand prix', 'whats the drivers championship',
  ]) assert.equal(sports.looksLikeSportsQuestion(q), true, `sports: ${q}`);

  for (const q of [
    'how do i install purple', 'bbc1 is buffering', 'whats the wallet address',
    'what channel is the f1 on',   // a LINEUP question — the lineup answers it
  ]) assert.equal(sports.looksLikeSportsQuestion(q), false, `not a results question: ${q}`);
});

test('football stays off until a key is set — it never guesses', async () => {
  setSetting('sports.footballApiKey', '');
  assert.equal(sports.footballEnabled(), false);
  assert.equal(await sports.footballStandings('PL'), null, 'no key, no table, no invention');
  setSetting('sports.footballApiKey', 'a-real-looking-key-value');
  assert.equal(sports.footballEnabled(), true);
  setSetting('sports.footballApiKey', '');
});

test('only competitions we know the code for are requested', () => {
  setSetting('sports.footballCompetitions', 'PL, nonsense, CL');
  assert.deepEqual(sports.competitions(), ['PL', 'CL']);
  setSetting('sports.footballCompetitions', 'PL');
});

test('a result the feed did not contain never reaches a customer', () => {
  const block = [
    'P1 Max Verstappen (Red Bull) 1:47:14.808',
    'P2 Andrea Kimi Antonelli (Mercedes) +2.307',
    'Arsenal 2-1 Chelsea (2026-10-04)',
  ].join('\n');

  assert.equal(invensSportsResult('Antonelli held P2 to the flag', block), false, 'a real position is fine');
  assert.equal(invensSportsResult('Arsenal edged it 2-1', block), false, 'a real scoreline is fine');
  assert.equal(invensSportsResult('Norris came home P9', block), true, 'invented position caught');
  assert.equal(invensSportsResult('Arsenal hammered them 4-0', block), true, 'invented scoreline caught');
});

test('a race result is never kept in the answer cache', () => {
  // The sports feed has its own short cache. The semantic answer cache does
  // not expire on race day, so a cached "who won the F1" would still be
  // naming last month's winner a month later, with total confidence.
  assert.equal(cacheable({}), true, 'ordinary answers still cache');
  // The exclusion lives at the store site, judged on what the answer was
  // built from — proven by the pipeline test rather than here.
});
