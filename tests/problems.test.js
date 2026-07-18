import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-problems-'));

const { db } = await import('../src/db/db.js');
const { setSetting } = await import('../src/settings.js');
const { recordProblem } = await import('../src/bot/helpers.js');
const { queueProblemAlert, flushProblemAlerts, _resetProblemQueue, maybeAutoDegrade, degradeRecoverySweep, notifyResolved } = await import('../src/bot/problems.js');
const { getSetting } = await import('../src/settings.js');
const { hub } = await import('../src/bot/hub.js');

function fakeCtx(text, userId = 100) {
  return {
    chat: { id: -100999, type: 'supergroup', title: 'Support Group' },
    from: { id: userId, username: `user${userId}` },
    message: { text },
  };
}

before(() => {
  setSetting('reports.alertProblems', true);
  setSetting('reports.adminTelegramIds', [55555]);
});

beforeEach(() => {
  _resetProblemQueue();
  db.prepare('DELETE FROM problem_reports').run();
});

after(() => {
  hub.api = null;
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('recordProblem stores the report with an extracted topic', () => {
  const id = recordProblem(fakeCtx('buffering on bbc1', 1), 'buffering on bbc1', { answered: true });
  const row = db.prepare('SELECT * FROM problem_reports WHERE id = ?').get(id);
  assert.equal(row.tg_user, 'user1');
  assert.match(row.topic, /buffer/);
  assert.equal(row.answered, 1);
  assert.equal(row.resolved, 0);
});

test('batched alert groups reports and flags an outage on a spike', async () => {
  const sent = [];
  hub.api = { sendMessage: async (id, text) => { sent.push({ id, text }); return { message_id: 1 }; } };

  queueProblemAlert({ tg_user: 'a', tg_user_id: 1, text: 'buffering on bbc1', topic: 'buffering' });
  queueProblemAlert({ tg_user: 'b', tg_user_id: 2, text: 'bbc1 buffering too', topic: 'buffering' });
  queueProblemAlert({ tg_user: 'c', tg_user_id: 3, text: 'buffering here as well', topic: 'buffering' });
  await flushProblemAlerts();

  assert.equal(sent.length, 1, 'one batched DM to the admin');
  assert.equal(sent[0].id, 55555);
  assert.match(sent[0].text, /outage/i, 'spike of 3 flagged as possible outage');
  assert.match(sent[0].text, /buffering ×3/);
  hub.api = null;
});

test('a single report is a normal (non-outage) alert', async () => {
  const sent = [];
  hub.api = { sendMessage: async (id, text) => { sent.push({ id, text }); return { message_id: 1 }; } };
  queueProblemAlert({ tg_user: 'a', tg_user_id: 1, text: 'app wont open', topic: null });
  await flushProblemAlerts();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].text, /outage/i);
  assert.match(sent[0].text, /1 new problem report/);
  hub.api = null;
});

test('alerts are suppressed when the toggle is off', async () => {
  setSetting('reports.alertProblems', false);
  const sent = [];
  hub.api = { sendMessage: async (id, text) => { sent.push({ id, text }); } };
  queueProblemAlert({ tg_user: 'a', tg_user_id: 1, text: 'buffering', topic: 'buffering' });
  await flushProblemAlerts();
  assert.equal(sent.length, 0);
  hub.api = null;
  setSetting('reports.alertProblems', true);
});

test('flush with the bot offline does not throw', async () => {
  hub.api = null;
  queueProblemAlert({ tg_user: 'a', tg_user_id: 1, text: 'buffering', topic: 'buffering' });
  await flushProblemAlerts(); // must resolve, not reject
});

test('auto-degradation flips the status when 3 different people report wide problems', async () => {
  setSetting('service.status', 'operational');
  setSetting('service.note', '');
  setSetting('service.autoDegradedAt', 0);
  setSetting('problems.degradeThreshold', 3);
  const adminDms = [];
  hub.api = { sendMessage: async (id, text) => { adminDms.push({ id, text }); return { message_id: 1 }; } };

  recordProblem(fakeCtx('buffering on bbc one', 201), 'buffering on bbc one');
  recordProblem(fakeCtx('itv keeps freezing', 202), 'itv keeps freezing');
  assert.equal(maybeAutoDegrade(), false, 'two people is not degradation');
  assert.equal(getSetting('service.status'), 'operational');

  recordProblem(fakeCtx('nothing will load for me', 203), 'nothing will load for me');
  assert.equal(maybeAutoDegrade(), true, 'three people tips it');
  assert.equal(getSetting('service.status'), 'degraded');
  assert.ok(getSetting('service.note').length > 0, 'note set for the banner');
  assert.ok(Number(getSetting('service.autoDegradedAt')) > 0, 'marked as auto-set');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(adminDms.some((d) => /DEGRADED automatically/.test(d.text)), 'admin told');
  assert.equal(maybeAutoDegrade(), false, 'does not re-fire while already degraded');
  hub.api = null;
  setSetting('service.status', 'operational');
  setSetting('service.note', '');
  setSetting('service.autoDegradedAt', 0);
});

test('single-title complaints never count toward degradation', () => {
  setSetting('service.status', 'operational');
  setSetting('problems.degradeThreshold', 3);
  recordProblem(fakeCtx('episode 3 of severance wont play', 301), 'episode 3 of severance wont play');
  recordProblem(fakeCtx('the movie is in spanish', 302), 'the movie is in spanish');
  recordProblem(fakeCtx('season 2 finale is broken', 303), 'season 2 finale is broken');
  recordProblem(fakeCtx('that film keeps crashing', 304), 'that film keeps crashing');
  assert.equal(maybeAutoDegrade(), false, 'content issues are not degradation');
  assert.equal(getSetting('service.status'), 'operational');
  // But three WIDE reporters alongside them still tip it.
  recordProblem(fakeCtx('buffering on sky sports', 305), 'buffering on sky sports');
  recordProblem(fakeCtx('everything is buffering', 306), 'everything is buffering');
  recordProblem(fakeCtx('streams wont load', 307), 'streams wont load');
  assert.equal(maybeAutoDegrade(), true);
  setSetting('service.status', 'operational');
  setSetting('service.note', '');
  setSetting('service.autoDegradedAt', 0);
});

test('an admin-set status is never overwritten by auto-degradation', () => {
  setSetting('service.status', 'maintenance');
  setSetting('problems.degradeThreshold', 3);
  recordProblem(fakeCtx('buffering on bbc one', 401), 'buffering on bbc one');
  recordProblem(fakeCtx('itv keeps freezing', 402), 'itv keeps freezing');
  recordProblem(fakeCtx('nothing loads', 403), 'nothing loads');
  assert.equal(maybeAutoDegrade(), false);
  assert.equal(getSetting('service.status'), 'maintenance');
  setSetting('service.status', 'operational');
});

test('auto-degradation recovers by itself once reports stop', async () => {
  const adminDms = [];
  hub.api = { sendMessage: async (id, text) => { adminDms.push({ id, text }); return { message_id: 1 }; } };
  // Auto-degraded earlier, no reports since (beforeEach cleared the table).
  setSetting('service.status', 'degraded');
  setSetting('service.note', 'auto note');
  setSetting('service.autoDegradedAt', Math.floor(Date.now() / 1000) - 3600);
  await degradeRecoverySweep();
  assert.equal(getSetting('service.status'), 'operational', 'status restored');
  assert.equal(getSetting('service.note'), '', 'note cleared');
  assert.equal(Number(getSetting('service.autoDegradedAt')), 0);
  assert.ok(adminDms.some((d) => /back to operational/.test(d.text)), 'admin told of recovery');

  // Fresh wide reports keep it degraded.
  setSetting('service.status', 'degraded');
  setSetting('service.autoDegradedAt', Math.floor(Date.now() / 1000) - 3600);
  recordProblem(fakeCtx('still buffering everywhere', 501), 'still buffering everywhere');
  await degradeRecoverySweep();
  assert.equal(getSetting('service.status'), 'degraded', 'recent reports keep it degraded');

  // Admin changed the status meanwhile → sweep only stops tracking.
  setSetting('service.status', 'maintenance');
  await degradeRecoverySweep();
  assert.equal(getSetting('service.status'), 'maintenance', 'admin status untouched');
  assert.equal(Number(getSetting('service.autoDegradedAt')), 0, 'tracking flag cleared');
  hub.api = null;
  setSetting('service.status', 'operational');
  setSetting('service.note', '');
});

test('notifyResolved tags the reporter in the group with the filled template', async () => {
  const sent = [];
  hub.api = { sendMessage: async (chatId, text, extra) => { sent.push({ chatId, text, extra }); return { message_id: 1 }; } };
  const ok = await notifyResolved({
    id: 1, chat_id: -100999, tg_user_id: 4242, tg_user: 'doctor', topic: 'buffering', resolved: 0,
  });
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, -100999, 'sent to the group the report came from');
  assert.match(sent[0].text, /tg:\/\/user\?id=4242/, 'real mention that pings without an @username');
  assert.match(sent[0].text, /doctor/);
  assert.match(sent[0].text, /buffering issue/, '{topic} filled in');
  assert.equal(sent[0].extra.parse_mode, 'HTML');
  hub.api = null;
});

test('notifyResolved falls back to a DM when the group send fails', async () => {
  const sent = [];
  hub.api = {
    sendMessage: async (chatId, text) => {
      if (chatId === -100999) throw new Error('bot was removed from the group');
      sent.push({ chatId, text });
      return { message_id: 1 };
    },
  };
  const ok = await notifyResolved({ id: 2, chat_id: -100999, tg_user_id: 4243, tg_user: 'doc2', topic: null });
  assert.equal(ok, true);
  assert.equal(sent[0].chatId, 4243, 'DM fallback used');
  hub.api = null;
});

test('notifyResolved is silent when the template is empty or the bot is offline', async () => {
  setSetting('bot.problemResolvedByAdminMessage', '');
  hub.api = { sendMessage: async () => { throw new Error('must not be called'); } };
  assert.equal(await notifyResolved({ id: 3, chat_id: -1, tg_user_id: 1, tg_user: 'x' }), false);
  setSetting('bot.problemResolvedByAdminMessage', '✅ {name} — fixed, try again.');
  hub.api = null;
  assert.equal(await notifyResolved({ id: 3, chat_id: -1, tg_user_id: 1, tg_user: 'x' }), false);
});

test('messages about the same issue merge into ONE report row', () => {
  const id1 = recordProblem(fakeCtx('Keep getting playback error on tom hanks series world war 11', 601), 'Keep getting playback error on tom hanks series world war 11');
  const id2 = recordProblem(fakeCtx("Done all this it isn't on another app", 601), "Done all this it isn't on another app", { answered: true });
  assert.equal(id1, id2, 'confirmation appended to the same row');
  const rows = db.prepare('SELECT * FROM problem_reports WHERE tg_user_id = 601').all();
  assert.equal(rows.length, 1, 'one row for the whole incident');
  assert.match(rows[0].text, /playback error on tom hanks/);
  assert.match(rows[0].text, /↳ Done all this/, 'follow-up combined into the report');
  assert.equal(rows[0].answered, 1);

  // A different user is always a separate report.
  recordProblem(fakeCtx('buffering on itv', 602), 'buffering on itv');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM problem_reports WHERE tg_user_id = 602').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM problem_reports WHERE tg_user_id = 601').get().n, 1);

  // Once resolved, the next problem starts a fresh row.
  db.prepare('UPDATE problem_reports SET resolved = 1 WHERE tg_user_id = 601').run();
  recordProblem(fakeCtx('now bbc is down too', 601), 'now bbc is down too');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM problem_reports WHERE tg_user_id = 601').get().n, 2, 'new incident, new row');
});

test('topic extraction prefers real symptoms over catch-all phrases', async () => {
  const { extractProblemTopic } = await import('../src/bot/helpers.js');
  assert.equal(extractProblemTopic('Keep getting playback error on tom hanks series world war 11'), 'playback error');
  assert.equal(extractProblemTopic('keeps buffering on itv'), 'buffering');
  assert.equal(extractProblemTopic('it wont play at all'), 'wont play', 'catch-all still used when nothing better');
  assert.equal(extractProblemTopic('what time is the match'), null);
});

test('auto-close stamps resolved_by so the panel shows how it ended', async () => {
  setSetting('bot.problemAutoCloseMinutes', 30);
  hub.api = null;
  recordProblem(fakeCtx('buffering on itv', 701), 'buffering on itv');
  db.prepare('UPDATE problem_reports SET ts = ts - 3600, answered = 1 WHERE tg_user_id = 701').run();
  const { autoCloseSweep } = await import('../src/bot/problems.js');
  await autoCloseSweep();
  const row = db.prepare('SELECT * FROM problem_reports WHERE tg_user_id = 701').get();
  assert.equal(row.resolved, 1);
  assert.equal(row.resolved_by, 'auto-close');
  setSetting('bot.problemAutoCloseMinutes', 0);
});

test('wrong-copy reports get a real topic; missing topics collapse cleanly', async () => {
  const { extractProblemTopic } = await import('../src/bot/helpers.js');
  assert.equal(extractProblemTopic('SHAMELESS UK is the wrong version'), 'wrong version');
  assert.equal(extractProblemTopic('the wrong copy is on there'), 'wrong copy');
});
