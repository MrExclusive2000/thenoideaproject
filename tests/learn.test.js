import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-learn-'));

const { db, now } = await import('../src/db/db.js');
const { setSetting } = await import('../src/settings.js');
const { logMessage } = await import('../src/bot/helpers.js');
const { worthLearning, reviewFlags, blockedReason, adminAnsweredThreads, harvestAdminAnswers } =
  await import('../src/ai/learn.js');

const GROUP = -100555;
const ADMIN_ID = 6001;
const MEMBER = { id: 71, username: 'punter' };
const ADMIN = { id: ADMIN_ID, username: 'boss' };

const msg = (id, replyTo = null) => ({
  message_id: id,
  ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
});

let aiServer;
let aiReply = 'QUESTION: How do I stop buffering?\nANSWER: Restart the app, then power-cycle the device.\nKEYWORDS: buffering, freezing, lag, restart';

// An exchange logged as it really arrives: a member's question, then the
// admin replying to it with Telegram's reply action.
let nextId = 100;
function exchange(question, answer, { adminAnswers = true } = {}) {
  const qId = nextId++;
  const aId = nextId++;
  logMessage(GROUP, MEMBER, question, null, msg(qId), 'Test Group');
  logMessage(GROUP, adminAnswers ? ADMIN : { id: 99, username: 'rando' }, answer, null, msg(aId, qId), 'Test Group');
}

before(async () => {
  setSetting('reports.adminTelegramIds', [ADMIN_ID]);
  setSetting('suggest.fromAnswers', true);
  setSetting('ai.embedEnabled', false); // clustering falls back to shared vocabulary
  aiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: aiReply }, finish_reason: 'stop' }], usage: { total_tokens: 10 } }));
    });
  });
  await new Promise((r) => aiServer.listen(0, '127.0.0.1', r));
  setSetting('ai.baseUrl', `http://127.0.0.1:${aiServer.address().port}/v1`);
  setSetting('ai.model', 'test-model');
  setSetting('ai.enabled', false); // most tests use the verbatim fallback
});

after(() => {
  aiServer?.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const reset = () => {
  db.prepare('DELETE FROM messages_log').run();
  db.prepare('DELETE FROM suggested_faqs').run();
  db.prepare('DELETE FROM faqs').run();
};

// ---- what is worth learning from -------------------------------------------

test('a real question and a real answer are worth learning from', () => {
  assert.equal(
    worthLearning('my stream keeps freezing on sky sports', 'Restart the app, then unplug the Firestick for 30 seconds and try a different link for that channel.'),
    true
  );
});

test('acknowledgements and one-liners are not knowledge', () => {
  assert.equal(worthLearning('is it down?', 'yes'), false, 'too short to be an answer');
  assert.equal(worthLearning('is it down?', '👍👍👍'), false, 'emoji only');
  assert.equal(worthLearning('ok?', 'Restart the app and it will be fine again shortly.'), false, 'question too short');
  assert.equal(worthLearning('whats up with the app today', '@punter sorted mate 👍'), false, 'a mention and two words');
});

// ---- what must never reach an FAQ ------------------------------------------

test('credentials and email addresses are blocked outright', () => {
  assert.ok(blockedReason('your login is username: dave42 password: hunter2 on the main app'));
  assert.ok(blockedReason('drop me a line at george@example.com and I will sort it out for you'));
  assert.equal(blockedReason('Restart the app and try a different link for that channel.'), null);
});

test('a blocked answer is never worth learning from, whatever else it says', () => {
  assert.equal(
    worthLearning('cant log in to the app at all', 'No problem, your username: dave42 and password: hunter2 should work fine now.'),
    false
  );
});

// ---- what gets flagged for the admin's eye ---------------------------------

test('per-person details are flagged rather than silently published', () => {
  assert.match(reviewFlags('Use code 9804805 in Downloader to install it.').join(' '), /long number/);
  assert.match(reviewFlags('Your access runs until 14/11/25, renew before then.').join(' '), /date/);
  assert.match(reviewFlags('I have sorted it @punter, try again now please.').join(' '), /@handle/);
  assert.match(reviewFlags('It is £15 for three months of access.').join(' '), /price/);
  assert.match(reviewFlags('Your subscription expired last week I am afraid.').join(' '), /one person's account/);
});

test('a general answer raises no flags', () => {
  assert.deepEqual(
    reviewFlags('Restart the app, then power-cycle the device by unplugging it for thirty seconds.'),
    []
  );
});

// ---- picking candidates out of the log -------------------------------------

test('only threads the admin answered become candidates', () => {
  reset();
  exchange('how do i fix constant buffering on live tv', 'Try a different link for that channel first, then restart the app and power-cycle the box.');
  exchange('anyone else getting freezing tonight', 'yeah same here mate happens to me all the time too', { adminAnswers: false });

  const found = adminAnsweredThreads({ sinceDays: 30 });
  assert.equal(found.length, 1, "another member's reply is not knowledge");
  assert.match(found[0].question, /constant buffering/);
  assert.match(found[0].answer, /different link/);
});

test('an unanswered question is not a candidate', () => {
  reset();
  logMessage(GROUP, MEMBER, 'does this work on a smart tv at all', null, msg(900), 'Test Group');
  assert.equal(adminAnsweredThreads({ sinceDays: 30 }).length, 0);
});

// ---- drafting ---------------------------------------------------------------

test("a draft is created from the admin's own words when the AI is off", async () => {
  reset();
  exchange('how do i install the app on a firestick', 'Open the Downloader app, enter the code, install the Purple app and sign in with your login.');

  const created = await harvestAdminAnswers({ sinceDays: 30 });
  assert.equal(created.length, 1);

  const row = db.prepare("SELECT * FROM suggested_faqs WHERE status = 'pending'").get();
  assert.equal(row.source, 'admin-answer', 'provenance is recorded so the panel can show it');
  assert.match(row.answer, /Downloader app/, "the admin's actual answer is the draft, not a placeholder");
  assert.doesNotMatch(row.answer, /\[ADMIN:/, 'no fill-this-in gap — the answer already existed');
});

test('a draft carrying per-person detail is stored flagged, not clean', async () => {
  reset();
  exchange('whats the code for the new build', 'Use code 9804805 in the Downloader app and it will pull the latest build down.');

  await harvestAdminAnswers({ sinceDays: 30 });
  const row = db.prepare("SELECT * FROM suggested_faqs WHERE status = 'pending'").get();
  assert.ok(row.needs_review, 'the admin is told to look before approving');
  assert.match(row.needs_review, /long number/);
});

test('nothing is ever enabled automatically', async () => {
  reset();
  exchange('do you have a guide for smarters setup', 'Yes — open the guides list in chat and pick the Smarters one, it walks through every step.');
  await harvestAdminAnswers({ sinceDays: 30 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM suggested_faqs WHERE status = 'pending'").get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM faqs').get().n, 0, 'the live FAQ list is untouched until approval');
});

test('a question the FAQs already answer is skipped', async () => {
  reset();
  db.prepare('INSERT INTO faqs (question, answer, keywords, enabled, priority, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)')
    .run('How do I install on Firestick?', 'Open Downloader and enter the code.', 'install, firestick, downloader, code', now(), now());
  exchange('how do i install on firestick', 'Open the Downloader app and enter the code, then install it and sign in.');

  const created = await harvestAdminAnswers({ sinceDays: 30 });
  assert.equal(created.length, 0, 'no point drafting what the bot can already answer');
});

test('the same question asked several ways produces one draft, not several', async () => {
  reset();
  exchange('my picture keeps buffering constantly on sports', 'Try a different link for that channel, then restart the app.');
  exchange('why is buffering happening constantly for me', 'Try a different link for the channel and restart the app afterwards.');

  const created = await harvestAdminAnswers({ sinceDays: 30 });
  assert.equal(created.length, 1, 'the cluster collapses to a single draft');
  const row = db.prepare("SELECT * FROM suggested_faqs WHERE status = 'pending'").get();
  assert.equal(row.ask_count, 2, 'how many people asked is kept, so the admin can prioritise');
});

// ---- the AI generalising path ----------------------------------------------

test('with the AI on, the draft is the generalised version', async () => {
  reset();
  setSetting('ai.enabled', true);
  try {
    exchange('why does my stream keep buffering mate', 'Alright @punter, restart the app and power-cycle the box.');
    await harvestAdminAnswers({ sinceDays: 30 });
    const row = db.prepare("SELECT * FROM suggested_faqs WHERE status = 'pending'").get();
    assert.equal(row.question, 'How do I stop buffering?', 'the question is rewritten for a future reader');
    assert.doesNotMatch(row.answer, /@punter/, 'the name the admin was replying to is gone');
    // The ORIGINAL still mentioned a handle, so the admin is still told to look.
    assert.match(row.needs_review || '', /@handle/);
  } finally {
    setSetting('ai.enabled', false);
  }
});

test('an answer that only made sense for one person is dropped, not published', async () => {
  reset();
  setSetting('ai.enabled', true);
  const prev = aiReply;
  aiReply = 'SKIP';
  try {
    exchange('is my account sorted now then', 'Yes all done, I have extended you by another three months from today.');
    const created = await harvestAdminAnswers({ sinceDays: 30 });
    assert.equal(created.length, 0, 'the model may refuse to generalise, and that refusal is honoured');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM suggested_faqs').get().n, 0);
  } finally {
    aiReply = prev;
    setSetting('ai.enabled', false);
  }
});

// ---- learning from cases ----------------------------------------------------
const { resolvedCaseAnswers, harvestResolvedCases, recurringUnresolved } =
  await import('../src/ai/learn.js');

// A case the customer came back and confirmed was fixed, with the bot's reply
// recorded against the question that opened it.
function resolvedCase(problem, fix, { userId = 80001, topic = 'buffering' } = {}) {
  const t = now();
  db.prepare('INSERT INTO problem_reports (chat_id, chat_title, tg_user_id, tg_user, text, topic, answered, resolved, resolved_by, ts) VALUES (?,?,?,?,?,?,1,1,?,?)')
    .run(GROUP, 'Test Group', userId, 'punter', problem, topic, 'user', t);
  const logId = logMessage(GROUP, { id: userId, username: 'punter' }, problem, null, msg(nextId++), 'Test Group');
  db.prepare('UPDATE messages_log SET reply_source = ?, bot_reply = ? WHERE id = ?').run('ai', fix, logId);
}

const resetCases = () => {
  db.prepare('DELETE FROM problem_reports').run();
  db.prepare('DELETE FROM messages_log').run();
  db.prepare('DELETE FROM suggested_faqs').run();
  db.prepare('DELETE FROM faqs').run();
};

test('the fix that resolved a case is recovered from the message log', () => {
  resetCases();
  resolvedCase('bbc one keeps buffering every few minutes', 'Try a different link for that channel, then restart the app and power-cycle the box.');
  const found = resolvedCaseAnswers({ sinceDays: 30 });
  assert.equal(found.length, 1);
  assert.match(found[0].answer, /different link/);
  assert.match(found[0].question, /buffering/);
});

test('a case nobody confirmed fixed is not treated as a working answer', () => {
  resetCases();
  const t = now();
  db.prepare("INSERT INTO problem_reports (chat_id, tg_user_id, text, topic, answered, resolved, resolved_by, ts) VALUES (?,?,?,?,1,1,'auto-close',?)")
    .run(GROUP, 80009, 'app keeps crashing on open', 'crashing', t);
  const logId = logMessage(GROUP, { id: 80009, username: 'x' }, 'app keeps crashing on open', null, msg(nextId++), 'Test Group');
  db.prepare("UPDATE messages_log SET bot_reply = 'Clear the cache.' WHERE id = ?").run(logId);
  assert.equal(resolvedCaseAnswers({ sinceDays: 30 }).length, 0, 'auto-close means they went quiet, not that it worked');
});

test('one confirmed fix is an anecdote — two make a draft', async () => {
  resetCases();
  resolvedCase('bbc one keeps buffering every few minutes', 'Try a different link for that channel, then restart the app and power-cycle the box.', { userId: 80002 });
  assert.equal((await harvestResolvedCases({ sinceDays: 30 })).length, 0, 'a single case proves nothing yet');

  resolvedCase('bbc one buffering constantly for me too', 'Try a different link for that channel, then restart the app and power-cycle the box.', { userId: 80003 });
  const created = await harvestResolvedCases({ sinceDays: 30 });
  assert.equal(created.length, 1, 'two people, same problem, same fix confirmed — now it is knowledge');

  const row = db.prepare("SELECT * FROM suggested_faqs WHERE status = 'pending'").get();
  assert.equal(row.source, 'resolved-case');
  assert.equal(row.ask_count, 2);
  assert.match(row.answer, /different link/);
});

test('recurring problems that never get fixed are reported, not drafted', async () => {
  resetCases();
  const t = now();
  for (const u of [81001, 81002, 81003]) {
    db.prepare("INSERT INTO problem_reports (chat_id, tg_user_id, text, topic, answered, resolved, escalated, ts) VALUES (?,?,?,?,1,0,1,?)")
      .run(GROUP, u, 'sky sports keeps freezing mid match', 'freezing', t);
  }
  const gaps = recurringUnresolved({ sinceDays: 30, minCount: 3 });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].topic, 'freezing');
  assert.equal(gaps[0].n, 3);
  assert.equal(gaps[0].escalated, 3);

  // And crucially: no FAQ is drafted from them. The bot already answered these
  // and the answer did not work — drafting from it would publish the failure.
  assert.equal((await harvestResolvedCases({ sinceDays: 30 })).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM suggested_faqs').get().n, 0);
});

test('a fix carrying one customer-specific detail is flagged like any other draft', async () => {
  resetCases();
  resolvedCase('whats the code to reinstall the app', 'Enter code 9804805 in the Downloader app and reinstall from there.', { userId: 80004, topic: 'install' });
  resolvedCase('need the code to reinstall it again', 'Enter code 9804805 in the Downloader app and reinstall from there.', { userId: 80005, topic: 'install' });
  await harvestResolvedCases({ sinceDays: 30 });
  const row = db.prepare("SELECT * FROM suggested_faqs WHERE status = 'pending'").get();
  assert.ok(row, 'drafted');
  assert.match(row.needs_review || '', /long number/);
});
