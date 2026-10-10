// "Have you got X channels?" answered from the real lineup.
//
// This lives in its own file because it has to run with embeddings never
// having worked. embeddingsProven() latches a module-level flag the first
// time it sees a vector, so once any test in a file turns embeddings on,
// every later test in that process is in full-AI mode. The live bot is NOT
// in full-AI mode — its dashboard says the embedding model has never
// answered — so it is on keyword matching, where a matched entry is sent
// as the answer rather than handed to the model. That is the path the bug
// was on, and the only way to exercise it is a process that never proves
// embeddings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-lineup-'));

const { db } = await import('../src/db/db.js');
const { seedStarterContent } = await import('../src/db/seed.js');
const { setSetting } = await import('../src/settings.js');
const { handleGroupMessage, handleDirectMessage } = await import('../src/bot/pipeline.js');

let aiServer;
let aiResponse = '';
let lastPrompt = null;

before(async () => {
  aiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastPrompt = body;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: aiResponse }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((r) => aiServer.listen(0, '127.0.0.1', r));

  seedStarterContent();
  setSetting('ai.baseUrl', `http://127.0.0.1:${aiServer.address().port}/v1`);
  setSetting('ai.model', 'test');
  setSetting('ai.embedEnabled', false); // keyword matching, like the live bot
  setSetting('bot.cooldownSeconds', 0);
  setSetting('services.name1', 'Exclusive');
  setSetting('services.name2', 'Flix');
  setSetting('services.url1', 'http://127.0.0.1:1');
  setSetting('services.xcUser1', 'u');
  setSetting('services.xcPass1', 'p');
  setSetting('bot.noListingMessage', "I don't have a listing for that at the moment. Give me the channel name and I'll look it up.");
  db.prepare('INSERT OR REPLACE INTO allowed_chats (chat_id, title, enabled, added_at) VALUES (-100123, ?, 1, 0)').run('Exclusive Support');
});

after(() => {
  aiServer?.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

function groupCtx(text) {
  const sent = [];
  return {
    chat: { id: -100123, type: 'supergroup', title: 'Exclusive Support' },
    from: { id: 55501, username: 'Y4FM', first_name: 'Y4FM' },
    message: { message_id: 11, text },
    me: { id: 999, username: 'Exclusive_Manager_Bot' },
    api: { sendMessage: async (c, m) => { sent.push(m); return { message_id: 1 }; } },
    reply: async (m) => { sent.push(m); return { message_id: 1 }; },
    replyWithChatAction: async () => {},
    sent,
  };
}

function dmCtx(text, userId) {
  const sent = [];
  return {
    chat: { id: userId, type: 'private' },
    from: { id: userId, username: 'cust', first_name: 'Cust' },
    message: { message_id: Math.floor(Math.random() * 1e6), text },
    me: { id: 999, username: 'Exclusive_Manager_Bot' },
    api: { sendMessage: async (c, m) => { sent.push(m); return { message_id: 1 }; } },
    reply: async (m) => { sent.push(m); return { message_id: 1 }; },
    replyWithChatAction: async () => {},
    sent,
  };
}

function setLineup(rows) {
  db.prepare('DELETE FROM xc_channels').run();
  for (const [id, name, cat] of rows) {
    db.prepare('INSERT INTO xc_channels (service, stream_id, name, category, epg_channel_id, updated_at) VALUES (1, ?, ?, ?, ?, 1)')
      .run(id, name, cat, `c${id}.uk`);
  }
}

const LIVE_QUESTION = 'On Exclusive are there any hunting channels on Live TV';

// The transcript:
//   "On Exclusive are there any hunting channels on Live TV"
//   → "Yes, hunting channels are available on the sports and PPV channels
//      in Live TV. Check around fight or kickoff time to find them."
//
// That is the seeded live-sports entry, almost word for word, with
// "hunting" pasted on the front. It matched at 0.44 on "live", "tv",
// "channel" and "on"; "hunting" appears in no entry at all and counted for
// nothing, so the answer was chosen entirely by filler words and a paying
// customer was told we carry something nobody had checked.
test('a written entry never answers "are there any X channels" when we hold a lineup', async () => {
  setLineup([[901, 'UK: Sky Sports Main Event', 'UK | SPORTS']]);
  aiResponse = 'Yes, hunting channels are available on the sports and PPV channels in Live TV.';

  const ctx = groupCtx(LIVE_QUESTION);
  await handleGroupMessage(ctx);
  const msg = ctx.sent.join('\n');

  assert.doesNotMatch(msg, /sports and PPV channels/i,
    'the live-sports entry answered a question about hunting channels');
  assert.match(msg, /listing|channel name/i,
    'with nothing of the kind in the lineup it should say so plainly');
});

test('and when the lineup does carry one, the real channel reaches the model', async () => {
  setLineup([
    [901, 'UK: Sky Sports Main Event', 'UK | SPORTS'],
    [902, 'UK: Hunting & Fishing TV', 'UK | OUTDOORS'],
  ]);
  aiResponse = 'Yes — UK: Hunting & Fishing TV is in the lineup, under Outdoors.';
  lastPrompt = null;

  const ctx = groupCtx(LIVE_QUESTION);
  await handleGroupMessage(ctx);

  assert.match(String(lastPrompt), /Hunting & Fishing TV/,
    'the matching channel was never attached to the prompt');
  assert.match(ctx.sent.join('\n'), /Hunting & Fishing TV/,
    'and the customer gets the channel we actually carry');
});

// The same filler words must not stop ordinary questions being answered
// from knowledge — the entries are still how most things get answered.
test('a normal sports question is still answered from knowledge', async () => {
  setLineup([[901, 'UK: Sky Sports Main Event', 'UK | SPORTS']]);
  aiResponse = 'Big live events are on the sports and PPV channels.';

  const ctx = groupCtx('Where can I watch the boxing tonight?');
  await handleGroupMessage(ctx);
  assert.ok(ctx.sent.join('\n').trim().length > 0, 'it still answers');
  assert.doesNotMatch(ctx.sent.join('\n'), /don't have a listing/i,
    'a fixture question is not a lineup-category question');
});


// The next few come from running against a real exported lineup — 36,400
// channels across 247 categories and forty-odd countries. None of them
// could have been found against a hand-written test lineup, because each
// needs a neighbour that only exists at that scale.
function lineup(rows) {
  db.prepare('DELETE FROM xc_channels').run();
  let id = 1;
  for (const [name, cat] of rows) {
    db.prepare('INSERT INTO xc_channels (service, stream_id, name, category, epg_channel_id, updated_at) VALUES (1, ?, ?, ?, ?, 1)')
      .run(id, name, cat, `c${id}`);
    id += 1;
  }
}

test('a word is matched on a boundary, not as a substring', async () => {
  const { findChannels } = await import('../src/xc.js');
  // Real rows: "hunting" is inside "Huntington", and two local news
  // stations in West Virginia were offered up as hunting channels.
  lineup([
    ['US NBC 3 (WSAZ) Huntington', 'USA | Regionals'],
    ['US CBS 13 (WOWK) Huntington', 'USA | Regionals'],
    ['Hunting & Fishing TV', 'UK | Documentary'],
  ]);
  const hits = findChannels('are there any hunting channels', { service: 1 }).map((c) => c.name);
  assert.deepEqual(hits, ['Hunting & Fishing TV'], 'Huntington is not a hunting channel');
});

test('a channel tagged for another country loses to an untagged one', async () => {
  const { findChannels } = await import('../src/xc.js');
  lineup([
    ['(AR) TNT SPORTS', 'Argentina'],
    ['CL: TNT SPORTS FHD', 'Chile'],
    ['TNT Sports 1 HD', 'UK | TNT Sports'],
  ]);
  assert.equal(findChannels('do you have tnt sports', { service: 1 })[0].name, 'TNT Sports 1 HD');
  // Unless they asked for it.
  assert.match(findChannels('do you have AR tnt sports', { service: 1 })[0].name, /\(AR\)/);
  // And a lineup that tags EVERYTHING has no discriminator there, so
  // nothing is demoted and the lot still comes back.
  lineup([['UK: BBC One HD', 'UK | Entertainment'], ['UK: BBC Two HD', 'UK | Entertainment']]);
  assert.equal(findChannels('bbc', { service: 1 }).length, 2, 'a prefix on every channel is not a country tag');
});

test('the whole phrase beats the sum of its words', async () => {
  const { findChannels } = await import('../src/xc.js');
  // "f1" is two characters and scored least, so these three came back
  // alongside the F1 channel as though they answered the question.
  lineup([
    ['SKY Sports 1', 'UK | Sky Sports'],
    ['SKY sports 16', 'UK | Sky Sports'],
    ['Sky Sports+ HD', 'UK | Sky Sports'],
    ['Sky Sports F1 FHD', 'UK | Sky Sports'],
  ]);
  assert.equal(findChannels('have you got sky sports f1', { service: 1 })[0].name, 'Sky Sports F1 FHD');
});

test('quality and frame-rate variants are one channel', async () => {
  const { findChannels, dedupeVariants } = await import('../src/xc.js');
  lineup([
    ['Sky Sports Main Event SD', 'UK | Sky Sports'],
    ['Sky Sports Main Event HD', 'UK | Sky Sports'],
    ['Sky Sports Main Event FHD', 'UK | Sky Sports'],
    ['Sky Sports Main Event FHD 50FPS', 'UK | Sky Sports'],
    ['Sky Sports Main Event UHD', 'UK | Sky Sports'],
  ]);
  const rows = dedupeVariants(findChannels('sky sports main event', { service: 1, limit: 12 }));
  assert.equal(rows.length, 1, 'five rows, one channel');
  assert.match(rows[0].name, /FHD$/, 'and the best picture of them');
});

test('a genre question is answered from the category, not from programme titles', async () => {
  const { findChannelsByCategory } = await import('../src/xc.js');
  lineup([
    ['ABC Kids', 'Australia | Bar TV'],
    ['CBeebies', 'UK | Kids'],
    ['Nick Jr', 'UK | Kids'],
  ]);
  const rows = findChannelsByCategory('are there any kids channels', { service: 1 }).map((c) => c.name);
  assert.ok(rows.includes('CBeebies') && rows.includes('Nick Jr'),
    'the channels filed under a Kids category are the answer');
});

// The lineup is a reseller feed and is mostly not British — UK categories
// are about 2% of 26,681 channels — so with no preference at all, "any
// music channels?" came back with Canadian ones and "any news channels?"
// with Australian ones.
test('a genre question with no country named prefers home', async () => {
  const { findChannelsByCategory } = await import('../src/xc.js');
  lineup([
    ['CA STINGRAY CLASSIC ROCK', 'Canada | Music'],
    ['PL|Music BOX', 'Poland | Music'],
    ['CLUBLAND TV', 'UK | Music'],
    ['KERRANG', 'UK | Music'],
  ]);
  const names = findChannelsByCategory('any music channels', { service: 1 }).map((c) => c.name);
  assert.deepEqual(names.sort(), ['CLUBLAND TV', 'KERRANG']);
});

test('naming a country stands the preference down — including by nationality', async () => {
  const { findChannelsByCategory } = await import('../src/xc.js');
  lineup([
    ['CLUBLAND TV', 'UK | Music'],
    ['PL|Music BOX', 'Poland | Music'],
    ['PL|4Fun Dance', 'Poland | Music'],
  ]);
  // Customers say the nationality; the lineup writes the country.
  const names = findChannelsByCategory('any polish music channels', { service: 1 }).map((c) => c.name);
  assert.ok(names.includes('PL|Music BOX'), 'polish has to find Poland');
  assert.ok(!names.includes('CLUBLAND TV'), 'and not be overridden by home');
});

test('home is decided by the category, not by words in the name', async () => {
  const { findChannelsByCategory } = await import('../src/xc.js');
  lineup([
    ['AU Sky News UK', 'Australia | Bar TV'],
    ['AU GB News', 'Australia | Bar TV'],
    ['BBC NEWS FHD', 'UK | News'],
  ]);
  const names = findChannelsByCategory('do you have any news channels', { service: 1 }).map((c) => c.name);
  assert.deepEqual(names, ['BBC NEWS FHD'],
    'an Australian channel with UK in its name is not a UK channel');
});

test('adult channels are never volunteered', async () => {
  const { findChannels, findChannelsByCategory } = await import('../src/xc.js');
  lineup([
    ['Babestation', 'Adults'],
    ['Playboy TV', 'Adults'],
    ['BBC ONE HD', 'UK | Entertainment'],
  ]);
  assert.equal(findChannelsByCategory('what channels do you have', { service: 1 })
    .some((c) => /babestation|playboy/i.test(c.name)), false);
  // Not even when the words line up — the section is answered from the
  // knowledge instead, which says it exists and is PIN-locked.
  assert.equal(findChannels('do you have adult channels', { service: 1 }).length, 0);
});

test('section headings are not offered as channels', async () => {
  const { findChannels } = await import('../src/xc.js');
  lineup([
    ['------- Kids Channels -------', 'Arabic'],
    ['======== SPORTS ========', 'Arabic'],
    ['CBeebies', 'UK | Kids'],
  ]);
  const names = findChannels('any kids channels', { service: 1 }).map((c) => c.name);
  assert.ok(!names.some((n) => /-----/.test(n)), 'a divider does not play');
});

// "What channels do you have?" is a fair question with 26,681 answers. It
// used to fall through to whichever entry shared a word with it — live
// that was the channel-not-working one, so somebody asking what they were
// buying got troubleshooting steps.
test('the browse question is answered from the shape of the lineup', async () => {
  const { lineupOverview, looksLikeBrowseQuestion } = await import('../src/xc.js');
  const rows = [];
  const push = (name, cat, n) => { for (let i = 0; i < n; i++) rows.push([`${name} ${i}`, cat]); };
  push('ent', 'UK | Entertainment', 40);
  push('ss', 'UK | Sky Sports', 30);
  push('us', 'USA', 25);
  push('ar', 'Arabic', 20);
  push('plumb', 'LIVE | ESPN+ (Direct)', 60);  // the feed's own plumbing
  push('x', 'Adults', 50);                      // never mentioned
  lineup(rows);

  const text = lineupOverview(1);
  assert.match(text, /Entertainment/, 'home sections are named');
  assert.match(text, /Sky Sports/);
  assert.match(text, /USA|Arabic/, 'and the big international ones');
  assert.doesNotMatch(text, /Adults?/i, 'adult categories are never named');
  assert.doesNotMatch(text, /\bLIVE\b/, 'nor the feed\'s own plumbing labels');

  // Plural is what separates it from "what channel is BBC One".
  assert.equal(looksLikeBrowseQuestion('what channels do you have'), true);
  assert.equal(looksLikeBrowseQuestion('how many channels do you have'), true);
  assert.equal(looksLikeBrowseQuestion('what channel is bbc one'), false);
  assert.equal(looksLikeBrowseQuestion('what channels do you have for kids'), false,
    'that is a genre question and has a better answer');
});

// Simulated as a customer who asks four times rather than once, the bot got
// it right on the canonical phrasing and then gave three different wrong
// answers: EPG refresh steps for "polish tv?", dead-channel troubleshooting
// for "channels from poland", and how to change the audio language for "ok
// and arabic ones". Each came from a keyword entry sharing a word with the
// question. The matcher wanted one of three English question frames wrapped
// around the word "channels", and a person asking again drops the frame.
test('the same channel question is understood however it is asked', async () => {
  const { looksLikeChannelCategoryQuestion: isCategory } = await import('../src/xc.js');

  for (const asked of ['do you have any polish channels', 'polish tv?', 'channels from poland',
    'ok and arabic ones', 'any kids channels', 'kids tv', 'anything for the kids',
    'and cartoons', 'what about arabic', 'german ones', 'got any turkish',
    'do you have any news channels']) {
    assert.equal(isCategory(asked), true, asked);
  }

  // A fault is not a request to browse: "my polish channels are gone" needs
  // the troubleshooting, and a list of what we carry answers nothing.
  for (const asked of ['my polish channels are not working', 'the kids channels are all frozen',
    'polish channels keep buffering', 'all my turkish channels have gone']) {
    assert.equal(isCategory(asked), false, asked);
  }

  // Words that only count next to "channels" or "tv". "Any news?" after a
  // film request asks whether it has been added; "the music is out of sync"
  // is a fault; "any films" is a VOD request. Each still arrives through the
  // question frames, so nothing is lost by refusing to read them alone.
  for (const asked of ['any news?', 'any films', 'the music is out of sync',
    'what channel is the boxing on', 'how do i install the app', 'i want a refund']) {
    assert.equal(isCategory(asked), false, asked);
  }
});

// Live, in a DM: "How to clear data for sky glass" was answered, and the
// follow-up "On firestick" came back "I'm not sure about the Firestick
// either" — about the device the bot had just named in its own reply. A
// bare device name is not a new question, it is the answer to "which
// device?", asked or not; the clarify memory only arms when the bot ENDS
// with a question, and a plain answer never does.
//
// Here rather than in pipeline.test.js because that file latches full-AI
// mode, where the stubbed model answers everything and the test passes
// whatever the routing does.
test('a bare device name continues the question before it', async () => {
  aiResponse = '';
  const first = dmCtx('how do i clear the app data', 93311);
  await handleDirectMessage(first);
  assert.match(first.sent.join('\n'), /Clearing app data/i, 'the clear-data entry answered');

  const second = dmCtx('on firestick', 93311);
  await handleDirectMessage(second);
  const followUp = second.sent.join('\n');
  assert.ok(followUp, 'the follow-up got a reply at all');
  assert.doesNotMatch(followUp, /not (?:totally )?sure/i, 'and not a brush-off');
  assert.match(followUp, /Clearing app data/i, 'still about clearing data, not installing');
  assert.doesNotMatch(followUp, /Downloader app from the Amazon/i,
    'a device name must not hand the question to the install entry');
});

// This one already worked, and is here so it keeps working: where the
// topic genuinely HAS a per-device answer, the device must still win —
// "how do I install it" then "iphone" means the iOS entry, not the generic
// one repeated. It is the case any fix for the one above can easily break.
test('a bare device name picks the device-specific entry when there is one', async () => {
  aiResponse = '';
  const first = dmCtx('how do i install it', 93312);
  await handleDirectMessage(first);

  const second = dmCtx('iphone', 93312);
  await handleDirectMessage(second);
  const followUp = second.sent.join('\n');
  assert.match(followUp, /Smarters Player Lite/i, 'the iOS entry answered');
  assert.doesNotMatch(followUp, /aftv\.news|Downloader/i, 'no sideloading at an Apple device');
});

// And a device name after a question the device cannot change is still
// that question: pricing is pricing on a Firestick.
test('a bare device name never changes the subject', async () => {
  aiResponse = '';
  const first = dmCtx('how much does it cost', 93313);
  await handleDirectMessage(first);
  const second = dmCtx('firestick', 93313);
  await handleDirectMessage(second);
  assert.match(second.sent.join('\n'), /Pricing depends/i, 'still answering about price');
});
