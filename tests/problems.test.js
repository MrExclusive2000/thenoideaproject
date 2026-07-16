import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-problems-'));

const { db } = await import('../src/db/db.js');
const { setSetting } = await import('../src/settings.js');
const { recordProblem } = await import('../src/bot/helpers.js');
const { queueProblemAlert, flushProblemAlerts, _resetProblemQueue } = await import('../src/bot/problems.js');
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
