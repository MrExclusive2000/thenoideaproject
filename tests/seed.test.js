import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-seed-'));

const { db, now } = await import('../src/db/db.js');
const { setSetting } = await import('../src/settings.js');
const { seedStarterContent, addStarterFaqs, STARTER_FAQS } = await import('../src/db/seed.js');
const { matchFaq } = await import('../src/faq/matcher.js');

after(() => {
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('first boot seeds starter FAQs and guides', () => {
  seedStarterContent();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM faqs').get().n, STARTER_FAQS.length);
  const guides = db.prepare('SELECT * FROM guides').all();
  assert.ok(guides.length >= 4);
  // Real-content guides ship visible; placeholder guides ship hidden.
  assert.equal(guides.find((g) => g.slug === 'install-firestick').visible, 1);
  assert.equal(guides.find((g) => g.slug === 'pay-with-crypto').visible, 1);
  assert.equal(guides.find((g) => g.slug === 'install-android').visible, 0);
  assert.equal(guides.find((g) => g.slug === 'customer-panel').visible, 0);
  // The user's real content made it in.
  assert.match(guides.find((g) => g.slug === 'install-firestick').body_md, /9804805/);
  assert.match(guides.find((g) => g.slug === 'pay-with-crypto').body_md, /Exodus/);
});

test('seeding is idempotent — second boot adds nothing', () => {
  seedStarterContent();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM faqs').get().n, STARTER_FAQS.length);
});

test('upgrade pass refreshes untouched defaults but never edited content', () => {
  const t = now();
  // Simulate a v1 install: version cleared, one FAQ still on its v1 default
  // answer, one FAQ edited by the admin, one guide edited by the admin.
  setSetting('seed.version', 0);
  const v1BufferingAnswer = 'Try these in order — they fix most buffering:\n1. Restart the app and your device.\n2. Restart your router.\n3. Clear the app cache (Settings > Applications > Manage Installed Applications > the app > Clear cache).\n4. Use 5GHz WiFi or wired ethernet if you can — 2.4GHz struggles with HD streams.\n5. Try a lower quality stream or a different link/server for the same channel.\n6. Run a speed test — HD needs about 10 Mbps, 4K about 25 Mbps.\nStill buffering after all that? Tell us the channel and the time it happened.';
  db.prepare('UPDATE faqs SET answer = ? WHERE question = ?')
    .run(v1BufferingAnswer, 'The app keeps buffering, freezing or stuttering — how do I fix it?');
  db.prepare('UPDATE faqs SET answer = ? WHERE question = ?')
    .run('MY CUSTOM ANSWER', 'Can I use a VPN with the app?');
  db.prepare('UPDATE guides SET body_md = ? WHERE slug = ?')
    .run('my own firestick guide text', 'install-firestick');
  db.prepare("DELETE FROM faqs WHERE question = 'How do I pay with crypto?'").run();

  seedStarterContent();

  const buffering = db.prepare('SELECT answer FROM faqs WHERE question = ?')
    .get('The app keeps buffering, freezing or stuttering — how do I fix it?');
  assert.match(buffering.answer, /XC or Smarters/, 'untouched v1 default upgraded to v2');
  const vpn = db.prepare('SELECT answer FROM faqs WHERE question = ?').get('Can I use a VPN with the app?');
  assert.equal(vpn.answer, 'MY CUSTOM ANSWER', 'edited FAQ left alone');
  const fireGuide = db.prepare("SELECT body_md FROM guides WHERE slug = 'install-firestick'").get();
  assert.equal(fireGuide.body_md, 'my own firestick guide text', 'edited guide left alone');
  const pay = db.prepare("SELECT 1 FROM faqs WHERE question = 'How do I pay with crypto?'").get();
  assert.ok(pay, 'missing starter FAQ re-added');
});

test('starter pack button skips questions that already exist', () => {
  db.prepare('DELETE FROM faqs').run();
  db.prepare('INSERT INTO faqs (question, answer, keywords, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(STARTER_FAQS[0].question.toUpperCase(), 'custom answer', '', now(), now());
  const added = addStarterFaqs();
  assert.equal(added, STARTER_FAQS.length - 1, 'existing question (case-insensitive) not duplicated');
  assert.equal(addStarterFaqs(), 0, 'nothing left to add');
});

test('starter FAQs actually match how people ask', () => {
  db.prepare('DELETE FROM faqs').run();
  addStarterFaqs();
  const faqs = db.prepare('SELECT * FROM faqs').all();
  const cases = [
    ['guys how do i instal this on my fire stick??', 'Firestick'],
    ['its constantly bufering and freezing on movies', 'buffering'],
    ['can you add the new season of severance pls', 'VOD'],
    ['how do i renew my sub', 'subscription'],
    ['can i pay with litecoin?', 'crypto'],
    ['is purple better than smarters', 'Purple'],
    ['whats the downloader code', 'Firestick'],
    ['how do i enable developer options', 'developer'],
    ['it says i cant install unknown apps', 'unknown'],
    ['saying invalid user', 'login'],
    ['its saying invalid user??', 'login'],
    ['keeps logging me out, invalid details', 'login'],
    ['how can my friend join the service?', 'friend'],
    ['my mate wants to sign up', 'friend'],
    ['how do i invite them to this group', 'friend'],
    ['dont know how to install the apps', 'Depends on your device'],
    ['how do i get the apps on my firestick', '9804805'],
    ['how do i install this on my android phone', 'Android installer link'],
    ['guys how do i instal this on my fire stick??', 'Downloader'],
    ['episode 3 of severance wont play', 'episode'],
    ['the movie is in spanish how do i get english', 'language'],
    ['wrong audio on this film', 'language'],
    ['this copy only has one language', 'language'],
  ];
  for (const [q, expect] of cases) {
    const { match } = matchFaq(q, faqs, 0.5);
    assert.ok(match, `no match for: ${q}`);
    assert.ok(
      match.question.toLowerCase().includes(expect.toLowerCase()) ||
      match.answer.toLowerCase().includes(expect.toLowerCase()),
      `"${q}" matched wrong FAQ: ${match.question}`
    );
  }
});
