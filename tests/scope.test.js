import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-scope-'));

const { isLikelyInScope, extractProblemTopic } = await import('../src/bot/helpers.js');

after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

test('device-setup and app questions are in scope', () => {
  for (const q of [
    'how do i enable developer options',
    'it says i cant install unknown apps',
    'which app is best purple or smarters',
    'buffering on bbc1',
    'how do i pay',
    'my subscription expired',
    'is the app on firestick',
    'does the app have a sports section',
  ]) {
    assert.ok(isLikelyInScope(q), `should be in scope: ${q}`);
  }
});

test('genuine chatter is out of scope', () => {
  for (const q of [
    'whats a good recipe for dinner tonight',
    'happy birthday mate have a great one',
    'lol that meme was hilarious',
    'anyone know a good plumber',
    // single generic words must not force in-scope (review finding):
    'who won the match last night',
    'that film was amazing',
    'fancy a game of pool later',
  ]) {
    assert.equal(isLikelyInScope(q), false, `should be out of scope: ${q}`);
  }
});

test('extractProblemTopic labels common symptoms', () => {
  assert.match(extractProblemTopic('buffering on bbc1'), /buffer/);
  assert.match(extractProblemTopic('sky sports keeps freezing'), /freez/);
  assert.match(extractProblemTopic('the app crashed again'), /crash/);
  assert.equal(extractProblemTopic('what time is the match'), null);
});
