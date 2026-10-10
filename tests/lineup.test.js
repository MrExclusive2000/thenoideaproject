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
const { handleGroupMessage } = await import('../src/bot/pipeline.js');

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
