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
    // service URL questions are always support ("Flix" = an app name the
    // admin put in an FAQ answer, so it is not in the keyword vocabulary):
    'whats the url for flix',
    'can i have the service url',
    'how do i install on my iphone',
    'does it work on ipad',
    // what-is/pricing questions are how new customers arrive:
    'what is this service',
    'how much does it cost',
    'can i get a trial',
    'will ufc be on tonight',
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

test("somebody else's product is not ours to support", async () => {
  // Live: "How do I reinstall Windows 10" came back with a five-step guide to
  // the Media Creation Tool and BIOS boot order, and "How do I update my
  // Windows PC" with Settings > Update & Security. We sell streaming. A
  // customer who follows that and wipes their laptop did it on our say-so.
  //
  // The cause is that install / reinstall / update are STRONG service
  // vocabulary — they are how people ask about our app — so the question was
  // forced in scope before the model ever saw it.
  const { hasScopeSignal, isLikelyInScope, namesForeignProduct } = await import('../src/bot/helpers.js');

  for (const q of [
    'How do I update my windows pc',
    'How do I reinstall windows 10',
    'How do I mute the telegram notifications',
    'how do i fix my printer',
    'how do i update my xbox',
    'how do i reinstall macos',
  ]) {
    assert.equal(namesForeignProduct(q), true, `not ours: ${q}`);
    assert.equal(hasScopeSignal(q), false, `must not reach the model: ${q}`);
    assert.equal(isLikelyInScope(q), false, q);
  }

  // Our thing running on their thing is still ours.
  for (const q of [
    'how do i install the app on my pc',
    'my firestick wont connect to my windows pc',
    'how do i install purple on firestick',
    'how do i reinstall the app',
    'can i watch it on my macbook',
  ]) {
    assert.equal(namesForeignProduct(q), false, `still ours: ${q}`);
    assert.ok(hasScopeSignal(q) || isLikelyInScope(q), `must still be answered: ${q}`);
  }

  // "Can I use it on Windows" names only their product, and is still a
  // question about ours — the shape of the question carries the subject. The
  // sales/compatibility check has to run before the foreign-product veto, or
  // the one question a prospective customer always asks gets brushed off.
  for (const q of [
    'can i use it on windows',
    'does it work on a chromebook',
    'will it run on windows 11',
    'is a chromecast supported',
  ]) {
    assert.equal(isLikelyInScope(q), true, `compatibility question: ${q}`);
    assert.equal(hasScopeSignal(q), true, `compatibility question: ${q}`);
  }
});
