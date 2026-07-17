import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-req-'));

const { db, now } = await import('../src/db/db.js');
const { setSetting } = await import('../src/settings.js');
const { parseVodRequest, recordVodRequest, notifyRequestAdded, setRequestService } = await import('../src/bot/requests.js');
const { hub } = await import('../src/bot/hub.js');

const sent = [];
function fakeCtx(text, userId = 100, chatId = -100777) {
  return { chat: { id: chatId }, from: { id: userId, username: `user${userId}` }, message: { text } };
}

before(() => {
  setSetting('reports.adminTelegramIds', [777]);
  setSetting('reports.alertVod', true);
});

beforeEach(() => {
  sent.length = 0;
  hub.api = { sendMessage: async (id, text, extra) => { sent.push({ id, text, extra }); return { message_id: 1 }; } };
  db.prepare('DELETE FROM vod_requests').run();
});

after(() => { hub.api = null; fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

test('parseVodRequest reads the taught format and ignores non-requests', () => {
  assert.equal(parseVodRequest('Request: Maze Runner: The Death Cure (2018)'), 'Maze Runner: The Death Cure (2018)');
  assert.equal(parseVodRequest('request inception 2010'), 'inception 2010');
  assert.equal(parseVodRequest('REQUEST - The Batman'), 'The Batman');
  assert.equal(parseVodRequest('can you request severance for me'), null, 'mid-sentence "request" is not a request line');
  assert.equal(parseVodRequest('how do i request a movie'), null);
  assert.equal(parseVodRequest('buffering on bbc1'), null);
  // Not VOD titles — support/admin actions that start with "request".
  assert.equal(parseVodRequest('Request a refund'), null);
  assert.equal(parseVodRequest('Request my money back please'), null);
  assert.equal(parseVodRequest('Request to cancel my sub'), null);
  assert.equal(parseVodRequest('request a callback'), null);
  assert.equal(parseVodRequest('Request: refund on my account'), null);
  // ...but a genuine title that merely contains a word is still captured.
  assert.equal(parseVodRequest('Request: Free Guy (2021)'), 'Free Guy (2021)');
});

test('recordVodRequest saves, acks, DMs the admin, and dedupes repeats', () => {
  setSetting('bot.requestAckMessage', 'Noted {title}!');
  const r1 = recordVodRequest(fakeCtx('x', 501), 'Maze Runner: The Death Cure (2018)');
  assert.equal(r1.ack, 'Noted Maze Runner: The Death Cure (2018)!');
  assert.ok(r1.requestId > 0);
  assert.equal(r1.deduped, false);
  const row = db.prepare('SELECT * FROM vod_requests').get();
  assert.equal(row.status, 'open');
  assert.equal(row.ask_count, 1);
  assert.ok(sent.some((m) => m.id === 777 && /VOD request/.test(m.text)), 'admin alerted');

  // Same title (punctuation/case-insensitive) bumps the count, one row.
  const r2 = recordVodRequest(fakeCtx('y', 502), 'maze runner the death cure 2018');
  assert.match(r2.ack, /already on the request list/);
  assert.equal(r2.deduped, true);
  assert.equal(r2.requestId, r1.requestId, 'same row');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vod_requests').get().n, 1, 'deduped');
  assert.equal(db.prepare('SELECT ask_count FROM vod_requests').get().ask_count, 2);
});

test('setRequestService attaches the service and DMs the admin', () => {
  const { requestId } = recordVodRequest(fakeCtx('z', 503), 'Dune Part Two (2024)');
  sent.length = 0;
  setRequestService(requestId, 'Exclusive');
  assert.equal(db.prepare('SELECT service FROM vod_requests WHERE id = ?').get(requestId).service, 'Exclusive');
  assert.ok(sent.some((m) => m.id === 777 && /is for: Exclusive/.test(m.text)), 'admin told the service');
});

test('notifyRequestAdded tags the requester in the chat it came from', async () => {
  setSetting('bot.requestAddedMessage', '{name}, {title} is now on!');
  const r = { id: 1, title: 'The Batman', tg_user_id: 601, tg_user: 'ash', chat_id: -100777, status: 'open' };
  const ok = await notifyRequestAdded(r);
  assert.equal(ok, true);
  assert.equal(sent[0].id, -100777, 'sent to the group it came from');
  assert.match(sent[0].text, /tg:\/\/user\?id=601/, 'real mention pings without an @username');
  assert.match(sent[0].text, /The Batman is now on/);
  assert.equal(sent[0].extra.parse_mode, 'HTML');
});

test('notifyRequestAdded falls back to a DM when the group send fails', async () => {
  setSetting('bot.requestAddedMessage', '{name}: {title} added');
  hub.api = { sendMessage: async (id, text) => { if (id < 0) throw new Error('kicked from group'); sent.push({ id, text }); return { message_id: 1 }; } };
  const ok = await notifyRequestAdded({ id: 2, title: 'Dune', tg_user_id: 602, tg_user: 'bob', chat_id: -100777, status: 'open' });
  assert.equal(ok, true);
  assert.equal(sent[0].id, 602, 'DM fallback');
});

test('parseNaturalVodRequest captures "can we get X" but never service asks', async () => {
  const { parseNaturalVodRequest } = await import('../src/bot/requests.js');
  // Captured.
  assert.equal(parseNaturalVodRequest('can we get The Batman'), 'The Batman');
  assert.equal(parseNaturalVodRequest('Can you add Dune Part Two (2024)'), 'Dune Part Two (2024)');
  assert.equal(parseNaturalVodRequest('any chance of adding Oppenheimer?'), 'Oppenheimer');
  assert.equal(parseNaturalVodRequest('please add severance season 3'), 'severance season 3');
  assert.equal(parseNaturalVodRequest('can we get the batman please?'), 'the batman');
  assert.equal(parseNaturalVodRequest('could u put on maze runner'), 'maze runner');
  // NOT captured — service/support asks and pronouns.
  for (const q of [
    'can we get the service url', 'can i get this on my ipad?', 'can we get a refund',
    'can you add my mate to the group', 'can we get an invite', 'could you get it working',
    'can i get a trial', 'can we get the app updated', 'can i get my login',
    'can you get me sorted', 'can we get more screens', 'can i get the pin',
    'how do i request a movie', 'i want to watch the batman',
  ]) {
    assert.equal(parseNaturalVodRequest(q), null, `should NOT capture: "${q}"`);
  }
});
