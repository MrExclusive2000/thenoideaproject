import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-join-'));

const { db, now } = await import('../src/db/db.js');
const { setSetting } = await import('../src/settings.js');
const { hub } = await import('../src/bot/hub.js');
const { recordJoin, markLeft, vetSweep, registerVetActions } = await import('../src/bot/joiners.js');
const { hashPassword } = await import('../src/web/accounts.js');

const CHAT = -100555;
db.prepare('INSERT INTO allowed_chats (chat_id, title, enabled, added_at) VALUES (?, ?, 1, ?)').run(CHAT, 'Test Group', now());
setSetting('reports.adminTelegramIds', [777]);
setSetting('group.vetDays', 3);

after(() => {
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

// Capture the callback handler grammY-style.
let vetHandler = null;
registerVetActions({ callbackQuery: (re, fn) => { vetHandler = { re, fn }; } });

function fakeCallbackCtx(data, { userId = 777 } = {}) {
  const calls = { answered: [], edited: [], banned: [], unbanned: [] };
  return {
    calls,
    from: { id: userId },
    match: data.match(vetHandler.re),
    answerCallbackQuery: async (opts) => calls.answered.push(opts),
    editMessageText: async (text) => calls.edited.push(text),
    api: {
      banChatMember: async (chatId, uid) => calls.banned.push([chatId, uid]),
      unbanChatMember: async (chatId, uid) => calls.unbanned.push([chatId, uid]),
    },
  };
}

test('joins are recorded; bots and admins are not', () => {
  recordJoin(CHAT, { id: 1001, username: 'newbie', first_name: 'New' });
  recordJoin(CHAT, { id: 1002, is_bot: true, first_name: 'SomeBot' });
  recordJoin(CHAT, { id: 777, first_name: 'TheAdmin' }); // admin id
  const rows = db.prepare('SELECT * FROM group_joiners').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tg_user_id, 1001);
  assert.equal(rows[0].status, 'pending');
});

test('sweep before the deadline stays quiet', async () => {
  const dms = [];
  hub.api = { sendMessage: async (id, text, extra) => { dms.push({ id, text, extra }); return { message_id: 1 }; } };
  await vetSweep();
  assert.equal(dms.length, 0, 'joiner is not overdue yet');
  hub.api = null;
});

test('overdue unlinked joiner triggers the Keep/Remove DM once', async () => {
  db.prepare('UPDATE group_joiners SET joined_at = ? WHERE tg_user_id = 1001').run(now() - 4 * 86400);
  const dms = [];
  hub.api = { sendMessage: async (id, text, extra) => { dms.push({ id, text, extra }); return { message_id: 1 }; } };
  await vetSweep();
  assert.equal(dms.length, 1);
  assert.equal(dms[0].id, 777);
  assert.match(dms[0].text, /@newbie/);
  assert.match(dms[0].text, /hasn't linked a customer account/);
  assert.ok(dms[0].extra.reply_markup, 'Keep/Remove buttons attached');
  assert.equal(db.prepare('SELECT status FROM group_joiners WHERE tg_user_id = 1001').get().status, 'asked');

  await vetSweep();
  assert.equal(dms.length, 1, 'not asked twice');
  hub.api = null;
});

test('Remove kicks WITHOUT ban and records the decision', async () => {
  const j = db.prepare('SELECT id FROM group_joiners WHERE tg_user_id = 1001').get();
  const ctx = fakeCallbackCtx(`vet:remove:${j.id}`);
  await vetHandler.fn(ctx);
  assert.deepEqual(ctx.calls.banned, [[CHAT, 1001]]);
  assert.deepEqual(ctx.calls.unbanned, [[CHAT, 1001]], 'unban right after = kick, not ban');
  assert.equal(db.prepare('SELECT status FROM group_joiners WHERE id = ?').get(j.id).status, 'removed');
  assert.match(ctx.calls.edited[0], /not banned/);
});

test('non-admins cannot press the buttons', async () => {
  const j = db.prepare('SELECT id FROM group_joiners WHERE tg_user_id = 1001').get();
  const ctx = fakeCallbackCtx(`vet:keep:${j.id}`, { userId: 424242 });
  await vetHandler.fn(ctx);
  assert.match(ctx.calls.answered[0].text, /Admins only/);
  assert.equal(db.prepare('SELECT status FROM group_joiners WHERE id = ?').get(j.id).status, 'removed', 'unchanged');
});

test('joiner who links a customer account is cleared automatically, no DM', async () => {
  db.prepare('INSERT INTO customers (username, password_hash, telegram_user_id, active, created_at) VALUES (?, ?, ?, 1, ?)')
    .run('signedup', hashPassword('pw-123456789'), 2001, now());
  recordJoin(CHAT, { id: 2001, username: 'signedup' });
  db.prepare('UPDATE group_joiners SET joined_at = ? WHERE tg_user_id = 2001').run(now() - 5 * 86400);

  const dms = [];
  hub.api = { sendMessage: async (id, text) => { dms.push({ id, text }); return { message_id: 1 }; } };
  await vetSweep();
  assert.equal(dms.length, 0, 'no DM for someone who signed up');
  assert.equal(db.prepare('SELECT status FROM group_joiners WHERE tg_user_id = 2001').get().status, 'linked');
  hub.api = null;
});

test('Keep sticks across a rejoin; leaving marks the row', async () => {
  const j = db.prepare('SELECT id FROM group_joiners WHERE tg_user_id = 1001').get();
  db.prepare("UPDATE group_joiners SET status = 'kept' WHERE id = ?").run(j.id);
  recordJoin(CHAT, { id: 1001, username: 'newbie' }); // rejoin
  assert.equal(db.prepare('SELECT status FROM group_joiners WHERE id = ?').get(j.id).status, 'kept', 'kept members are not re-vetted');

  recordJoin(CHAT, { id: 3001, username: 'quickleaver' });
  markLeft(CHAT, 3001);
  assert.equal(db.prepare('SELECT status FROM group_joiners WHERE tg_user_id = 3001').get().status, 'left');
});

test('invite attribution is stored', () => {
  recordJoin(CHAT, { id: 4001, username: 'friend' }, 1001);
  assert.equal(db.prepare('SELECT invited_by FROM group_joiners WHERE tg_user_id = 4001').get().invited_by, 1001);
});
