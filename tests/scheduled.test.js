import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-sched-'));

const { db, now } = await import('../src/db/db.js');
const { setSetting, getSetting } = await import('../src/settings.js');
const {
  sweepScheduledBroadcasts, expiryReminders, expiryUpsells, generateFaqSuggestions, suggestFaqsSweep,
} = await import('../src/bot/scheduled.js');
const { hub } = await import('../src/bot/hub.js');

const sent = [];

before(() => {
  db.prepare("INSERT INTO allowed_chats (chat_id, title, enabled, added_at) VALUES (-100555, 'Group', 1, 0)").run();
  setSetting('reports.adminTelegramIds', [777]);
  setSetting('ai.enabled', false); // suggestion tests use the template fallback
});

beforeEach(() => {
  sent.length = 0;
  hub.api = { sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 1 }; } };
  db.prepare('DELETE FROM scheduled_broadcasts').run();
  db.prepare('DELETE FROM broadcasts').run();
  db.prepare('DELETE FROM customers').run();
  db.prepare('DELETE FROM unanswered').run();
  db.prepare('DELETE FROM suggested_faqs').run();
});

after(() => {
  hub.api = null;
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('a due one-off broadcast sends once, lands in history and disables itself', async () => {
  db.prepare("INSERT INTO scheduled_broadcasts (body, send_at, repeat, enabled, created_at) VALUES ('UFC tonight!', ?, 'once', 1, 0)")
    .run(now() - 60);
  await sweepScheduledBroadcasts();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, -100555);
  assert.match(sent[0].text, /UFC tonight/);
  const row = db.prepare('SELECT * FROM scheduled_broadcasts').get();
  assert.equal(row.enabled, 0, 'one-off disabled after sending');
  const hist = db.prepare("SELECT * FROM broadcasts WHERE created_by = 'scheduler'").get();
  assert.equal(hist.status, 'sent', 'recorded in broadcast history');

  await sweepScheduledBroadcasts();
  assert.equal(sent.length, 1, 'never sent twice');
});

test('a recurring broadcast advances into the future — no catch-up spam after downtime', async () => {
  // Missed three days while the server was off.
  db.prepare("INSERT INTO scheduled_broadcasts (body, send_at, repeat, enabled, created_at) VALUES ('Daily reminder', ?, 'daily', 1, 0)")
    .run(now() - 3 * 86400);
  await sweepScheduledBroadcasts();
  assert.equal(sent.length, 1, 'exactly one send despite three missed slots');
  const row = db.prepare('SELECT * FROM scheduled_broadcasts').get();
  assert.equal(row.enabled, 1, 'recurring stays active');
  assert.ok(row.send_at > now(), 'next send is in the future');
  assert.ok(row.send_at <= now() + 86400, 'next send is within one period');
});

test('future and paused broadcasts do not send; offline bot retries later', async () => {
  db.prepare("INSERT INTO scheduled_broadcasts (body, send_at, repeat, enabled, created_at) VALUES ('Future', ?, 'once', 1, 0)").run(now() + 3600);
  db.prepare("INSERT INTO scheduled_broadcasts (body, send_at, repeat, enabled, created_at) VALUES ('Paused', ?, 'once', 0, 0)").run(now() - 60);
  await sweepScheduledBroadcasts();
  assert.equal(sent.length, 0);

  db.prepare("INSERT INTO scheduled_broadcasts (body, send_at, repeat, enabled, created_at) VALUES ('Due', ?, 'once', 1, 0)").run(now() - 60);
  hub.api = null; // bot offline
  await sweepScheduledBroadcasts();
  const due = db.prepare("SELECT * FROM scheduled_broadcasts WHERE body = 'Due'").get();
  assert.equal(due.enabled, 1, 'not consumed while the bot is offline — retries next minute');
});

test('expiry reminder uses the template; upsell fires once on lapse, never for old lapses', async () => {
  setSetting('portal.expiryReminderDays', 3);
  setSetting('portal.expiryReminderMessage', 'Oi {name} — {days} day(s) left!');
  setSetting('portal.expiryUpsellMessage', 'Come back {name}!');
  const t = now();
  const ins = db.prepare('INSERT INTO customers (username, password_hash, display_name, telegram_user_id, active, expires_at, created_at) VALUES (?, ?, ?, ?, 1, ?, 0)');
  ins.run('soon', 'x', 'Ben', 4001, t + 2 * 86400);      // expires in 2 days → reminder
  ins.run('lapsed', 'x', 'Sam', 4002, t - 3600);          // expired an hour ago → upsell
  ins.run('longgone', 'x', 'Old', 4003, t - 10 * 86400);  // expired 10 days ago → silence
  ins.run('nolink', 'x', 'Ghost', null, t - 3600);        // no Telegram → nothing to send

  await expiryReminders();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 4001);
  assert.equal(sent[0].text, 'Oi Ben — 2 day(s) left!');
  await expiryReminders();
  assert.equal(sent.length, 1, 'reminder not repeated');

  await expiryUpsells();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].chatId, 4002);
  assert.equal(sent[1].text, 'Come back Sam!');
  await expiryUpsells();
  assert.equal(sent.length, 2, 'upsell sent exactly once per lapse');
});

test('suggestions cluster repeats, skip covered questions, and clear the inbox', async () => {
  db.prepare("INSERT INTO faqs (question, answer, keywords, enabled, priority, created_at, updated_at) VALUES ('How do I install on Firestick?', 'Use Downloader with our code.', 'install, firestick, downloader, code', 1, 0, 0, 0)").run();
  const ins = db.prepare("INSERT INTO unanswered (text, source, resolved, ts) VALUES (?, 'ai-refused', 0, ?)");
  const t = now();
  ins.run('how do i chromecast to my tv', t);
  ins.run('can i cast this with chromecast', t);
  ins.run('chromecast from my phone possible?', t);
  ins.run('do you have a roku app', t);
  ins.run('how do i install on firestick', t); // already covered by an FAQ → skipped

  const created = await generateFaqSuggestions();
  assert.equal(created.length, 2, 'two clusters suggested, covered question skipped');
  const rows = db.prepare("SELECT * FROM suggested_faqs WHERE status = 'pending' ORDER BY ask_count DESC").all();
  assert.equal(rows[0].ask_count, 3, 'chromecast cluster counted');
  assert.match(rows[0].question, /chromecast/i);
  assert.match(rows[0].answer, /\[ADMIN:/, 'AI off → template draft flags admin');
  assert.ok(JSON.parse(rows[0].samples).length >= 2, 'original phrasings kept');
  const inbox = db.prepare('SELECT COUNT(*) n FROM unanswered WHERE resolved = 0').get().n;
  assert.equal(inbox, 1, 'clustered questions cleared; only the covered one remains open');

  // Re-running does not duplicate pending suggestions.
  ins.run('how to use chromecast with this', now());
  const again = await generateFaqSuggestions();
  assert.equal(again.length, 0, 'similar question matches the pending suggestion, no duplicate');
});

test('the weekly sweep DMs the admin and respects the toggle', async () => {
  setSetting('suggest.faqs', true);
  setSetting('suggest.lastRunAt', 0);
  db.prepare("INSERT INTO unanswered (text, source, resolved, ts) VALUES ('does it work on xbox', 'ai-refused', 0, ?)").run(now());
  await suggestFaqsSweep();
  assert.ok(sent.some((m) => m.chatId === 777 && /suggested FAQ/i.test(m.text)), 'admin DMed the drafts');
  assert.ok(Number(getSetting('suggest.lastRunAt')) > 0, 'cadence recorded');

  sent.length = 0;
  await suggestFaqsSweep();
  assert.equal(sent.length, 0, 'not run again within the week');

  setSetting('suggest.faqs', false);
  setSetting('suggest.lastRunAt', 0);
  await suggestFaqsSweep();
  assert.equal(sent.length, 0, 'toggle off = no runs');
  setSetting('suggest.faqs', true);
});

test('promo rotation: posts on cadence, rotates the pool, respects hour and toggle', async () => {
  const { promoSweep } = await import('../src/bot/scheduled.js');
  setSetting('promo.enabled', true);
  setSetting('promo.intervalDays', 1);
  setSetting('promo.hour', new Date().getUTCHours());
  setSetting('promo.messages', ['Promo A — /invite your mates!', 'Promo B — renewals take minutes.']);
  setSetting('promo.lastSentAt', 0);
  setSetting('promo.nextIndex', 0);

  await promoSweep();
  assert.equal(sent.length, 1, 'due promo posted');
  assert.match(sent[0].text, /Promo A/);
  const hist = db.prepare("SELECT * FROM broadcasts WHERE created_by = 'promo'").get();
  assert.equal(hist.status, 'sent', 'promo recorded in history');

  await promoSweep();
  assert.equal(sent.length, 1, 'not re-posted within the interval');

  setSetting('promo.lastSentAt', now() - 2 * 86400);
  await promoSweep();
  assert.equal(sent.length, 2, 'next cycle fires');
  assert.match(sent[1].text, /Promo B/, 'pool rotates');

  setSetting('promo.lastSentAt', 0);
  setSetting('promo.hour', (new Date().getUTCHours() + 3) % 24);
  await promoSweep();
  assert.equal(sent.length, 2, 'wrong hour = no post');

  setSetting('promo.hour', new Date().getUTCHours());
  setSetting('promo.enabled', false);
  await promoSweep();
  assert.equal(sent.length, 2, 'toggle off = silent');
  setSetting('promo.enabled', false);
});
