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
  assert.equal(guides.find((g) => g.slug === 'install-android').visible, 1);
  assert.equal(guides.find((g) => g.slug === 'customer-panel').visible, 0);
  // The user's real content made it in.
  assert.match(guides.find((g) => g.slug === 'install-firestick').body_md, /\{purple\}|\{skyglass\}/);
  assert.match(guides.find((g) => g.slug === 'install-android').body_md, /aftv\.news\/\{purple\}/);
  assert.match(guides.find((g) => g.slug === 'pay-with-crypto').body_md, /Exodus/);
  // iOS guide ships hidden until the admin fills in the service URL.
  assert.equal(guides.find((g) => g.slug === 'install-ios').visible, 0);
  assert.match(guides.find((g) => g.slug === 'install-ios').body_md, /apps\.apple\.com/);
  assert.match(guides.find((g) => g.slug === 'install-ios').body_md, /YOUR-SERVICE-URL/);
});

test('which-service FAQ ships disabled, reading the names from settings', async () => {
  const { withAdminContact } = await import('../src/settings.js');
  const row = db.prepare('SELECT * FROM faqs WHERE question = ?').get('Which service am I on?');
  assert.ok(row, 'seeded');
  assert.equal(row.enabled, 0, 'disabled out of the box');
  assert.match(row.answer, /THM/);
  // No hand-editable placeholder: the brand names come from Bot settings, so
  // they cannot drift out of step with the rest of the system.
  assert.doesNotMatch(row.answer, /SERVICE-NAME-/);
  assert.match(row.answer, /\{service1\}/);
  setSetting('services.name1', 'Exclusive');
  setSetting('services.name2', 'Flix');
  const rendered = withAdminContact(row.answer);
  assert.match(rendered, /you're on Exclusive/);
  assert.match(rendered, /you're on Flix/);
});

test('no starter entry ships with an unfilled placeholder in it', () => {
  // A placeholder that reaches a customer reads as a bug in the service. The
  // DEFAULT-PIN entry shipped exactly like that for several versions.
  for (const f of STARTER_FAQS) {
    assert.doesNotMatch(f.answer, /DEFAULT-PIN|SERVICE-NAME-|SERVICE-URL-|YOUR-[A-Z-]+/,
      `placeholder left in: ${f.question}`);
  }
});

test('starter entries name Sky Glass as the main app, not Purple', () => {
  // Purple was the recommended app for most of this pack's life, so a stale
  // "use the Purple App as your main app" is the easiest thing to leave behind.
  for (const f of STARTER_FAQS) {
    assert.doesNotMatch(f.answer, /Purple App as your main|Use the Purple App as your main/i,
      `still recommends Purple as the main app: ${f.question}`);
  }
  const which = STARTER_FAQS.find((f) => /Which app should I use/.test(f.question));
  assert.match(which.answer, /Sky Glass/);
});

test('starter content never points a customer at the customer panel', () => {
  // The bot was unlinked from the portal, so "check the customer panel" is an
  // instruction a customer cannot follow — and the bot won't hand out a link.
  for (const f of STARTER_FAQS) {
    assert.doesNotMatch(f.answer, /customer panel/i, `panel reference left in: ${f.question}`);
  }
});

test('no starter entry hard-codes a download code', () => {
  // A code written out by hand is a second place it has to be kept up to
  // date — including in keyword lists, which fail silently when it changes.
  for (const f of STARTER_FAQS) {
    assert.doesNotMatch(f.answer, /\b\d{7,}\b/, `code baked into the answer: ${f.question}`);
    assert.doesNotMatch(f.keywords || '', /\b\d{6,}\b/, `code baked into the keywords: ${f.question}`);
  }
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
  const v10AndroidAnswer = 'Open our Android installer link on your device (ask here or check the customer panel if you don’t have it), pick the app you want — we recommend the Purple App — and allow installs from unknown sources if your phone asks (the prompt varies by model). Install it, open it, and log in with your service details.';
  db.prepare('UPDATE faqs SET answer = ? WHERE question = ?')
    .run(v10AndroidAnswer, 'How do I install the app on an Android phone or tablet?');
  db.prepare('UPDATE faqs SET answer = ? WHERE question = ?')
    .run('MY CUSTOM ANSWER', 'Can I use a VPN with the app?');
  // Guides still carrying the old placeholder marker get replaced too.
  db.prepare('UPDATE guides SET body_md = ?, visible = 0 WHERE slug = ?')
    .run('> **Admin: edit this guide first!** Replace ANDROID-INSTALLER-LINK...', 'install-android');
  db.prepare('UPDATE guides SET body_md = ? WHERE slug = ?')
    .run('my own firestick guide text', 'install-firestick');
  db.prepare("DELETE FROM faqs WHERE question = 'How do I pay with crypto?'").run();

  seedStarterContent();

  const buffering = db.prepare('SELECT answer FROM faqs WHERE question = ?')
    .get('The app keeps buffering, freezing or stuttering — how do I fix it?');
  assert.match(buffering.answer, /XC or Smarters/, 'untouched v1 default upgraded to v2');
  const android = db.prepare('SELECT answer FROM faqs WHERE question = ?')
    .get('How do I install the app on an Android phone or tablet?');
  assert.match(android.answer, /aftv\.news\/\{purple\}/, 'untouched v10 default upgraded to the current generation');
  const androidGuide = db.prepare("SELECT body_md, visible FROM guides WHERE slug = 'install-android'").get();
  assert.match(androidGuide.body_md, /aftv\.news\/\{purple\}/, 'placeholder guide replaced with real content');
  assert.equal(androidGuide.visible, 1, 'replaced guide made visible');
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
    ['how do i get the apps on my firestick', 'Downloader'],
    ['how do i install this on my android phone', 'aftv.news'],
    ['whats the android download link', 'aftv.news'],
    ['how do i install this on my iphone', 'Smarters Player Lite'],
    ['can i get this on my ipad?', 'App Store'],
    ['is there an ios app', 'Smarters Player Lite'],
    ['whats the service url for the iphone app', 'Xtream'],
    ['what is this service?', 'VOD library'],
    ['what firestick is best', '4K'],
    ['which firestick should i buy for this', '4K'],
    ['is the 4k max worth it', '4K Max'],
    ['does the 4k select work with your apps', 'Vega'],
    ['will this work on vega os', 'Vega'],
    ['will ufc be on tonight?', 'PPV'],
    ['what channel is the boxing on', 'PPV'],
    ['is the fight on tonight', 'PPV'],
    ['will ufc be on vod?', 'Request'],
    ['when will the new movie be on vod', 'Request'],
    ['the tv guide is empty', 'EPG'],
    ['epg shows nothing for tomorrow', 'EPG'],
    ['how many devices can i use', 'plan'],
    ['can i watch on two tvs at the same time', 'plan'],
    ['does it work on my samsung smart tv', 'Samsung'],
    ['the app keeps crashing on startup', 'Force stop'],
    ['what internet speed do i need', 'Mbps'],
    ['can i record shows', 'record'],
    ['is there catch up', 'catch'],
    ['can i pay by card', 'Litecoin'],
    ['do you take paypal', 'Litecoin'],
    ['app keeps crashing', "crashes or won't open"],
    ['how much does it cost', 'prices'],
    ['is there a free trial', 'prices'],
    ['how do i turn subtitles off', 'subtitles icon'],
    ['what do you get with the service', 'Live TV'],
    ['does the service have vod on demand?', 'VOD'],
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

test('which-service FAQ matches how people ask once the admin enables it', () => {
  setSetting('services.name1', 'Exclusive');
  setSetting('services.name2', 'Flix');
  db.prepare("UPDATE faqs SET enabled = 1 WHERE question = 'Which service am I on?'").run();
  const faqs = db.prepare('SELECT * FROM faqs').all();
  for (const q of [
    'what service am i on',
    'which service do i have?',
    'my username starts with thm what service is that',
    'how do i know what service im subscribed to',
  ]) {
    const { match } = matchFaq(q, faqs, 0.5);
    assert.ok(match, `no match for: ${q}`);
    assert.match(match.question, /Which service am I on/, `"${q}" matched wrong FAQ: ${match?.question}`);
  }
  // It must not hijack service-URL questions from the iOS FAQ.
  const { match: urlMatch } = matchFaq('whats the service url for the iphone app', faqs, 0.5);
  assert.ok(urlMatch, 'url question still matches');
  assert.match(urlMatch.question, /iPhone or iPad/, `url question matched wrong FAQ: ${urlMatch?.question}`);
});

test('the v22 URL FAQ is retired: never seeded, unedited leftovers deleted', () => {
  // Not part of the starter pack any more (it leaked both services' URLs).
  assert.ok(!STARTER_FAQS.some((f) => /service URL to log in/.test(f.question)), 'not seeded');
  // A leftover untouched v22 row from a live install gets cleaned up...
  const v22 = "The service URL depends on which service you're on — check the username you log in with:\n- Randomly generated (a mix of letters and numbers): use SERVICE-URL-1\n- Starts with THM: use SERVICE-URL-2\nEnter it exactly as written, together with your normal username and password.\nNot sure which you are? Reply to this message with just your username (never your password!) and I'll tell you.";
  db.prepare('INSERT INTO faqs (question, answer, keywords, enabled, priority, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0, 0)')
    .run('What is the service URL to log in with?', v22, 'url');
  db.prepare('INSERT INTO faqs (question, answer, keywords, enabled, priority, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0, 0)')
    .run('What is the service URL to log in with? (edited)', 'MY OWN URL ANSWER', 'url');
  setSetting('seed.version', 0);
  seedStarterContent();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM faqs WHERE answer = ?').get(v22).n, 0, 'untouched leftover deleted');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM faqs WHERE answer = 'MY OWN URL ANSWER'").get().n, 1, 'edited row untouched');
  db.prepare("DELETE FROM faqs WHERE answer = 'MY OWN URL ANSWER'").run();
  // The iOS FAQ points at the code-side URL flow instead of the circular ask-here.
  const ios = db.prepare('SELECT answer FROM faqs WHERE question = ?').get('How do I install the app on an iPhone or iPad (iOS)?');
  assert.match(ios.answer, /what's the service URL/, 'iOS FAQ points at the URL flow');
});

test('the customer-panel entry is retired: never seeded, unedited leftovers deleted', () => {
  assert.ok(!STARTER_FAQS.some((f) => /customer panel/i.test(f.question)), 'not seeded');
  const v25 = 'The customer panel has everything in one place: service maintenance updates, app download links, URLs and setup info, VOD recommendations, the sports guide, your account details, FAQs and payment information. Log in with your account details and everything assigned to you appears automatically. Ask here if you need the panel link.';
  db.prepare('INSERT INTO faqs (question, answer, keywords, enabled, priority, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0, 0)')
    .run("What's in the customer panel?", v25, 'panel');
  db.prepare('INSERT INTO faqs (question, answer, keywords, enabled, priority, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0, 0)')
    .run("What's in the customer panel? (mine)", 'MY OWN PANEL ANSWER', 'panel');
  setSetting('seed.version', 0);
  seedStarterContent();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM faqs WHERE answer = ?').get(v25).n, 0, 'untouched leftover deleted');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM faqs WHERE answer = 'MY OWN PANEL ANSWER'").get().n, 1, 'edited row untouched');
  db.prepare("DELETE FROM faqs WHERE answer = 'MY OWN PANEL ANSWER'").run();
});

test('the PIN entry loses its placeholder and is switched on for untouched installs', () => {
  const v25Pin = "Some categories are PIN-locked (parental controls). The default PIN in our apps is DEFAULT-PIN — you can change it in the app's settings under Parental Controls. If that PIN doesn't work in your app, ask here and we'll sort it.";
  const q = 'What is the PIN for locked categories (parental controls)?';
  // An install that never touched it: still disabled, still quoting DEFAULT-PIN.
  db.prepare('UPDATE faqs SET answer = ?, enabled = 0 WHERE question = ?').run(v25Pin, q);
  setSetting('seed.version', 0);
  seedStarterContent();
  const row = db.prepare('SELECT * FROM faqs WHERE question = ?').get(q);
  assert.doesNotMatch(row.answer, /DEFAULT-PIN/, 'the placeholder is gone');
  assert.equal(row.enabled, 1, 'and it is usable now that there is nothing to fill in');

  // An entry the admin disabled AFTER writing their own answer stays off.
  db.prepare('UPDATE faqs SET answer = ?, enabled = 0 WHERE question = ?').run('OUR PIN IS SECRET', q);
  setSetting('seed.version', 0);
  seedStarterContent();
  const mine = db.prepare('SELECT * FROM faqs WHERE question = ?').get(q);
  assert.equal(mine.answer, 'OUR PIN IS SECRET', 'edited answer left alone');
  assert.equal(mine.enabled, 0, 'and left switched off');
});

test('the 9804805 generation is recognised as untouched and refreshed', () => {
  // These defaults shipped with the code written out in full. They were
  // recorded as previous versions but never wired into the comparison, so an
  // install carrying them looked hand-edited and would never have been
  // refreshed — it would still be quoting a dead code today.
  const q = 'How do I install the app on my Firestick?';
  const v21 = 'Install the Downloader app from the Amazon app store, open it and enter code 9804805, then click Go. That page has all our apps — install the Purple App as your main one, plus XC or Smarters as backups (the same login works in all of them).\nIf the Firestick blocks the install: Settings > My Fire TV > About > click the device name 7–10 times to unlock Developer Options, then enable both options in there and go back to Downloader.\nOnce installed, open the app and log in with your service details. Full walkthrough is in the Firestick guide.';
  db.prepare('UPDATE faqs SET answer = ? WHERE question = ?').run(v21, q);
  setSetting('seed.version', 0);
  seedStarterContent();
  const row = db.prepare('SELECT answer FROM faqs WHERE question = ?').get(q);
  assert.doesNotMatch(row.answer, /9804805/, 'the dead code is gone');
  assert.match(row.answer, /\{skyglass\}/, 'refreshed to the current generation');
});

test('a fresh install renders a real download code, not a missing-code marker', async () => {
  const { withAdminContact } = await import('../src/settings.js');
  // On a brand-new install nobody has been into Bot settings yet, and the very
  // first question asked is "what's the code".
  for (const f of STARTER_FAQS) {
    assert.doesNotMatch(withAdminContact(f.answer), /\[(purple|skyglass) code not set\]/,
      `no code configured for: ${f.question}`);
  }
});

test('the Sky Glass entry ships ready to use and owns sky-glass questions', () => {
  const row = db.prepare('SELECT * FROM faqs WHERE question = ?')
    .get('How do I install the Sky Glass app?');
  assert.ok(row, 'seeded');
  assert.match(row.answer, /\{skyglass\}/, 'the code comes from settings, not hand-edited into the answer');
  assert.doesNotMatch(row.answer, /\d{6,}/, 'no code is baked into the text');
  assert.equal(row.enabled, 1, 'Sky Glass is the recommended app, so it ships ready to use');

  const faqs = db.prepare('SELECT * FROM faqs').all();
  for (const q of [
    'sky glass',
    'how do i install sky glass',
    'can i have the sky glass code',
  ]) {
    const { match } = matchFaq(q, faqs, 0.5);
    assert.ok(match, `no match for: ${q}`);
    assert.match(match.question, /Sky Glass/, `"${q}" matched wrong FAQ: ${match?.question}`);
  }
  // A GENERIC code question must still land on the general install entry —
  // the two must not share enough vocabulary to cancel each other out.
  const { match: dl } = matchFaq('whats the downloader code', faqs, 0.5);
  assert.ok(dl, 'a generic downloader-code question still matches something');
  assert.match(dl.answer, /\{purple\}|\{skyglass\}/, 'and it is an install entry');
  // ...and app-comparison questions stay with the which-app FAQ.
  const { match: cmp } = matchFaq('is purple better than smarters', faqs, 0.5);
  assert.match(cmp.question, /Which app should I use/, `comparison matched wrong FAQ: ${cmp?.question}`);
});
