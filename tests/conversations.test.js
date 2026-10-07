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
