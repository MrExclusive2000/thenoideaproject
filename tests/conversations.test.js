import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-conv-'));

const { db } = await import('../src/db/db.js');
const { setSetting } = await import('../src/settings.js');
const { logMessage, setLogSource } = await import('../src/bot/helpers.js');
const { conversationThreads, unansweredThreads, conversationStats, toJsonl } =
  await import('../src/conversations.js');

const GROUP = -100777;
const ADMIN_ID = 5001;
const MEMBER = { id: 42, username: 'punter' };
const ADMIN = { id: ADMIN_ID, username: 'boss' };

// A Telegram message as the bot receives it: an id, and a reply_to when the
// sender used the reply action.
const msg = (id, replyTo = null) => ({
  message_id: id,
  ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
});

before(() => {
  setSetting('reports.adminTelegramIds', [ADMIN_ID]);
});

after(() => {
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('a logged message keeps its Telegram id, reply link and admin flag', () => {
  db.prepare('DELETE FROM messages_log').run();
  logMessage(GROUP, MEMBER, 'is the app down?', null, msg(1), 'Test Group');
  logMessage(GROUP, ADMIN, 'yeah, back in 10 mins', null, msg(2, 1), 'Test Group');

  const rows = db.prepare('SELECT * FROM messages_log ORDER BY id').all();
  assert.equal(rows[0].tg_msg_id, 1);
  assert.equal(rows[0].reply_to_tg_msg_id, null);
  assert.equal(rows[0].is_admin, 0, 'a member is not an admin');
  assert.equal(rows[1].tg_msg_id, 2);
  assert.equal(rows[1].reply_to_tg_msg_id, 1, 'the reply link survives');
  assert.equal(rows[1].is_admin, 1, 'the admin is flagged at write time');
  assert.equal(rows[1].chat_title, 'Test Group');
});

test('an admin reply is threaded onto the question it answered', () => {
  db.prepare('DELETE FROM messages_log').run();
  logMessage(GROUP, MEMBER, 'whats the url for the app?', null, msg(10), 'Test Group');
  logMessage(GROUP, ADMIN, 'DM me and I will send it over', null, msg(11, 10), 'Test Group');
  // Unrelated chatter between the two must NOT be swept in as an answer.
  logMessage(GROUP, { id: 77, username: 'rando' }, 'anyone watching the game', null, msg(12), 'Test Group');

  const threads = conversationThreads({ chatId: GROUP });
  assert.equal(threads.length, 1, 'only the question that got a reply becomes a thread');
  const [t] = threads;
  assert.equal(t.question, 'whats the url for the app?');
  assert.equal(t.answers.length, 1);
  assert.equal(t.answers[0].from, 'admin');
  assert.equal(t.answers[0].username, 'boss');
  assert.match(t.answers[0].text, /DM me/);
});

test("the bot's own answer is captured alongside human ones", () => {
  db.prepare('DELETE FROM messages_log').run();
  const logId = logMessage(GROUP, MEMBER, 'how do i install it', null, msg(20), 'Test Group');
  setLogSource(logId, 'ai', 'Open the Downloader app and enter the code.');
  logMessage(GROUP, ADMIN, 'and reboot after, always helps', null, msg(21, 20), 'Test Group');

  const [t] = conversationThreads({ chatId: GROUP });
  assert.equal(t.answers.length, 2, 'bot answer and admin follow-up both attach');
  assert.equal(t.answers[0].from, 'bot');
  assert.equal(t.answers[0].via, 'ai');
  assert.match(t.answers[0].text, /Downloader app/);
  assert.equal(t.answers[1].from, 'admin');
});

test('setLogSource without reply text records the verdict only', () => {
  db.prepare('DELETE FROM messages_log').run();
  const logId = logMessage(GROUP, MEMBER, 'sausage', null, msg(30), 'Test Group');
  setLogSource(logId, 'offtopic');
  const row = db.prepare('SELECT * FROM messages_log WHERE id = ?').get(logId);
  assert.equal(row.reply_source, 'offtopic');
  assert.equal(row.bot_reply, null, 'no answer was sent, so none is claimed');
});

test('questions nobody answered are listed separately', () => {
  db.prepare('DELETE FROM messages_log').run();
  logMessage(GROUP, MEMBER, 'my box keeps freezing on sky sports', null, msg(40), 'Test Group');
  const answered = logMessage(GROUP, MEMBER, 'how do i pay', null, msg(41), 'Test Group');
  setLogSource(answered, 'ai', 'Message the admin to renew.');
  logMessage(GROUP, ADMIN, 'morning all', null, msg(42), 'Test Group');

  const open = unansweredThreads({ chatId: GROUP });
  assert.equal(open.length, 1, 'answered questions and admin chatter are excluded');
  assert.match(open[0].text, /freezing on sky sports/);
});

test('stats and JSONL export reflect what was harvested', () => {
  db.prepare('DELETE FROM messages_log').run();
  const logId = logMessage(GROUP, MEMBER, 'is there an android app', null, msg(50), 'Test Group');
  setLogSource(logId, 'ai', 'Yes — same code works on Android.');
  logMessage(GROUP, ADMIN, 'aftv.news/12345 for android too', null, msg(51, 50), 'Test Group');

  const stats = conversationStats(0);
  assert.equal(stats.total, 2);
  assert.equal(stats.fromAdmins, 1);
  assert.equal(stats.botAnswered, 1);
  assert.equal(stats.humanReplies, 1);
  assert.equal(stats.chats[0].chat_title, 'Test Group');

  const jsonl = toJsonl(conversationThreads({ chatId: GROUP }));
  const parsed = jsonl.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].question, 'is there an android app');
  assert.equal(parsed[0].answers.length, 2);
});

test('a long answer is stored in full, not clipped to the old 500 chars', () => {
  db.prepare('DELETE FROM messages_log').run();
  const long = 'step '.repeat(300).trim(); // 1499 chars
  logMessage(GROUP, ADMIN, long, null, msg(60), 'Test Group');
  const row = db.prepare('SELECT text FROM messages_log').get();
  assert.equal(row.text.length, long.length, 'a real troubleshooting answer survives intact');
});

// --- escalation path ---------------------------------------------------------
// There is no ticket system any more: everything the bot can't handle is
// pointed at a human, and the handle lives in one setting.
const { withAdminContact } = await import('../src/settings.js');

test('{admin} expands to the configured handle', () => {
  setSetting('bot.adminContact', '@thebossman');
  assert.equal(
    withAdminContact('Not sure on that — {admin} and they will sort it.'),
    'Not sure on that — message @thebossman directly and they will sort it.'
  );
});

test('a handle saved without the @ still renders as a mention', () => {
  setSetting('bot.adminContact', 'thebossman');
  assert.match(withAdminContact('{admin}'), /@thebossman/);
});

test('an unset handle still reads as a sentence, never a raw placeholder', () => {
  setSetting('bot.adminContact', '');
  const out = withAdminContact("I couldn't answer that — {admin}.");
  assert.equal(out, "I couldn't answer that — message an admin directly.");
  assert.doesNotMatch(out, /\{admin\}/, 'a placeholder must never reach a customer');
});

test('every {admin} in a message is replaced, not just the first', () => {
  setSetting('bot.adminContact', '@boss');
  const out = withAdminContact('{admin} for pricing, or {admin} for renewals.');
  assert.doesNotMatch(out, /\{admin\}/);
  assert.equal(out.match(/@boss/g).length, 2);
});

// --- version / update reporting ----------------------------------------------
const { localBuild, describeUpdate } = await import('../src/build.js');

test('the running build is reported from the checkout', () => {
  const b = localBuild();
  assert.equal(typeof b.isGit, 'boolean');
  if (b.isGit) {
    assert.match(b.commit, /^[0-9a-f]{7,}$/, 'a real commit hash');
    assert.ok(b.branch, 'and the branch it came from');
  }
});

test('"up to date" is only claimed when nothing is upstream', () => {
  const git = { isGit: true, commit: 'abc1234', branch: 'main' };
  assert.match(describeUpdate(git, { behind: 0, ahead: 0 }), /Up to date/);
  assert.doesNotMatch(describeUpdate(git, { behind: 2, latest: 'def5678 newer' }), /Up to date/);
});

test('being behind says whether a restart will actually fix it', async () => {
  const git = { isGit: true, commit: 'abc1234', branch: 'main' };
  const { config } = await import('../src/config.js');
  const prev = config.autoUpdate;
  try {
    config.autoUpdate = true;
    assert.match(describeUpdate(git, { behind: 3, latest: 'x' }), /pull them automatically/);
    config.autoUpdate = false;
    // The dangerous case: restarting looks like it should update and doesn't.
    assert.match(describeUpdate(git, { behind: 3, latest: 'x' }), /will NOT pull/);
  } finally {
    config.autoUpdate = prev;
  }
});

test('a failed check says why rather than claiming to be up to date', () => {
  const git = { isGit: true, commit: 'abc1234', branch: 'main' };
  const msg = describeUpdate(git, { error: 'fetch-failed' });
  assert.match(msg, /Couldn't reach GitHub/);
  assert.doesNotMatch(msg, /Up to date/, 'an unreachable remote is not evidence of being current');
  assert.match(describeUpdate({ isGit: false }, null), /wasn't installed from git/);
});

test('applying an update reports no-op when already current', async () => {
  const { applyUpdate } = await import('../src/build.js');
  const r = await applyUpdate();
  // This checkout tracks a real branch; whatever the outcome, it must be a
  // structured answer and never a thrown error from git.
  assert.equal(typeof r.ok, 'boolean');
  if (r.ok && !r.changed) assert.match(r.message, /Already on the latest/);
  if (!r.ok) assert.ok(r.message.length, 'a failure always explains itself');
});

// --- AI base URL correction ---------------------------------------------------
const { correctedBaseUrl } = await import('../src/ai/client.js');

test('an SSL failure on a plain-HTTP endpoint names BOTH problems at once', () => {
  // The exact shape of a pasted Pelican Ollama address.
  const fix = correctedBaseUrl('https://node-2.example.co.uk:25569', { sslFailed: true });
  assert.equal(fix.url, 'http://node-2.example.co.uk:25569/v1');
  assert.equal(fix.notes.length, 2, 'scheme and path are reported together, not one failure apart');
});

test('a real HTTPS API is never told to downgrade just because /v1 is missing', () => {
  const fix = correctedBaseUrl('https://api.vendor.com');
  assert.equal(fix.url, 'https://api.vendor.com/v1', 'adds the path, keeps the scheme');
  assert.doesNotMatch(fix.notes.join(' '), /http:\/\//);
});

test('a correct URL needs no correction', () => {
  assert.equal(correctedBaseUrl('http://host:11434/v1'), null);
  assert.equal(correctedBaseUrl('https://api.openai.com/v1'), null);
  assert.equal(correctedBaseUrl('http://host:11434/v1/'), null, 'a trailing slash is not a problem');
});

test('an empty base URL suggests nothing rather than inventing one', () => {
  assert.equal(correctedBaseUrl(''), null);
  assert.equal(correctedBaseUrl(null), null);
});

// --- dead-endpoint circuit breaker -------------------------------------------
// A dead endpoint cost ~10s of TCP connect timeout PER CALL, and the bot calls
// it for the embedding, the answer and even to reword a canned greeting — so
// every message took 10-20s and ended in "I couldn't answer that". From the
// outside that is indistinguishable from the bot being offline.
const { circuitOpen, recordFailure, recordSuccess, breakerStatus, isConnectionError, _resetCircuits } =
  await import('../src/ai/breaker.js');

test('a slow model never trips the breaker', () => {
  _resetCircuits();
  // Generation timeouts are NORMAL on a CPU node. Treating them as "endpoint
  // down" would disable the AI exactly when it is working, just slowly.
  for (let i = 0; i < 10; i++) recordFailure('http://node:11434/v1', 'TimeoutError');
  assert.equal(circuitOpen('http://node:11434/v1'), false);
  assert.equal(isConnectionError('TimeoutError'), false);
});

test('repeated connection failures stop the bot retrying a dead endpoint', () => {
  _resetCircuits();
  const url = 'http://dead:11434/v1';
  assert.equal(recordFailure(url, 'UND_ERR_CONNECT_TIMEOUT'), false, 'one failure is not proof');
  assert.equal(circuitOpen(url), false);
  assert.ok(recordFailure(url, 'UND_ERR_CONNECT_TIMEOUT'), 'the second opens it');
  assert.equal(circuitOpen(url), true);
  assert.equal(breakerStatus(url).down, true);
  assert.ok(breakerStatus(url).retryInSeconds > 0);
});

test('the wrong-scheme error counts as unreachable', () => {
  // The exact failure a https:// address against a plain-HTTP Ollama gives.
  assert.ok(isConnectionError('ERR_SSL_WRONG_VERSION_NUMBER'));
  assert.ok(isConnectionError('ECONNREFUSED'));
  assert.ok(isConnectionError('ENOTFOUND'));
});

test('a working endpoint clears the circuit', () => {
  _resetCircuits();
  const url = 'http://flaky:11434/v1';
  recordFailure(url, 'ECONNREFUSED');
  recordFailure(url, 'ECONNREFUSED');
  assert.equal(circuitOpen(url), true);
  recordSuccess(url);
  assert.equal(circuitOpen(url), false, 'one good answer puts it straight back in service');
  assert.equal(breakerStatus(url).down, false);
});

test('circuits are tracked per endpoint, not globally', () => {
  _resetCircuits();
  recordFailure('http://a:1/v1', 'ECONNREFUSED');
  recordFailure('http://a:1/v1', 'ECONNREFUSED');
  assert.equal(circuitOpen('http://a:1/v1'), true);
  assert.equal(circuitOpen('http://b:2/v1'), false, 'a second endpoint is unaffected');
});

// --- download codes live in settings, not in the text ------------------------
test('{purple} and {skyglass} are filled in from settings', () => {
  setSetting('apps.purpleCode', '3775005');
  setSetting('apps.skyGlassCode', '3793766');
  const out = withAdminContact('Firestick: code {skyglass}. Android: aftv.news/{skyglass}. Purple is {purple}.');
  assert.equal(out, 'Firestick: code 3793766. Android: aftv.news/3793766. Purple is 3775005.');
});

test('an unset code is visible, never a silent blank', () => {
  setSetting('apps.purpleCode', '');
  const out = withAdminContact('Enter code {purple} and click Go.');
  // "enter code  and click Go" would ship a broken instruction to a customer
  // and nobody would notice until they tried to follow it.
  assert.match(out, /\[purple code not set\]/);
  setSetting('apps.purpleCode', '3775005');
});

test('changing a code updates every mention at once', () => {
  setSetting('apps.skyGlassCode', '3793766');
  const text = 'Use {skyglass}, or open aftv.news/{skyglass}, or tell a friend the code {skyglass}.';
  assert.equal((withAdminContact(text).match(/3793766/g) || []).length, 3);
  setSetting('apps.skyGlassCode', '9999999');
  assert.equal((withAdminContact(text).match(/9999999/g) || []).length, 3, 'one field, every mention');
  setSetting('apps.skyGlassCode', '3793766');
});

// --- the two brand names come from settings too ------------------------------
test('{service1} and {service2} are filled in from the configured names', () => {
  setSetting('services.name1', 'Exclusive');
  setSetting('services.name2', 'Flix');
  const out = withAdminContact("Random username: {service1}. Starts with THM: {service2}.");
  assert.equal(out, 'Random username: Exclusive. Starts with THM: Flix.');
});

test('an unset service name is visible, never a silent blank', () => {
  setSetting('services.name2', '');
  // "you're on ." is worse than useless — the admin has to be able to see
  // that the name was never filled in.
  assert.match(withAdminContact("you're on {service2}"), /\[service 2 name not set\]/);
  setSetting('services.name2', 'Flix');
});

test('a service URL is never substituted — names only', () => {
  // The per-user login URL has its own flow precisely so it cannot ride along
  // in shared text. Nothing here may open a second route to it.
  setSetting('services.url1', 'http://real-login.example:8080');
  const out = withAdminContact('{service1} {serviceurl1} {url1}');
  assert.doesNotMatch(out, /real-login\.example/);
  assert.match(out, /\{serviceurl1\} \{url1\}/, 'unknown placeholders are left as written');
});

// --- the answer token cap ------------------------------------------------------
test('the answer cap allows a full install guide', async () => {
  const { getSetting } = await import('../src/settings.js');
  const cap = Number(getSetting('ai.maxTokens'));
  // A real Firestick install guide (7 numbered steps plus an
  // unknown-sources section) runs past 220 tokens and was being cut
  // mid-instruction. Roughly 4 characters per token.
  assert.ok(cap >= 400, `answer cap is ${cap} — too tight for a step-by-step guide`);
});
