import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-svc-'));

const { db } = await import('../src/db/db.js');
const m = await import('../src/service-memory.js');

after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

test('a service, once learned, survives a restart', () => {
  m.rememberService(1001, 2, 'told');
  assert.equal(m.recallServiceNumber(1001), 2);
  // It lived in memory with a ten-minute life before, so the same person was
  // asked over and over; this is a row in the database.
  assert.ok(db.prepare('SELECT 1 FROM tg_service WHERE tg_user_id = 1001').get());
});

test('a renewal onto the other service overwrites the old answer', () => {
  m.rememberService(1002, 2, 'told');
  assert.equal(m.rememberService(1002, 1, 'username', 'randomuser'), true, 'changed');
  assert.equal(m.recallServiceNumber(1002), 1, 'people move, and the newer evidence wins');
  assert.equal(m.recallService(1002).username, 'randomuser');
});

test('weaker evidence never overwrites stronger', () => {
  // A linked account is the account itself. A guess must not undo it.
  m.rememberService(1003, 1, 'linked', 'ashley99');
  m.rememberService(1003, 2, 'guess');
  assert.equal(m.recallServiceNumber(1003), 1);
  // But an admin saying so outranks everything — they are looking at it.
  m.rememberService(1003, 2, 'admin');
  assert.equal(m.recallServiceNumber(1003), 2);
});

test('stale strong evidence gives way, because people renew and never say', () => {
  m.rememberService(1004, 1, 'linked', 'ashley99');
  // Four months on, nobody has told the bot anything.
  db.prepare('UPDATE tg_service SET updated_at = updated_at - ? WHERE tg_user_id = 1004').run(130 * 86400);
  m.rememberService(1004, 2, 'told');
  assert.equal(m.recallServiceNumber(1004), 2, 'a fresh answer beats a four-month-old one');
});

test('the same answer again just refreshes the clock', () => {
  m.rememberService(1005, 1, 'told');
  const before = m.recallService(1005).updated_at;
  db.prepare('UPDATE tg_service SET updated_at = updated_at - 1000 WHERE tg_user_id = 1005').run();
  assert.equal(m.rememberService(1005, 1, 'told'), false, 'nothing changed, so nothing is reported');
  assert.ok(m.recallService(1005).updated_at >= before - 1, 'but it is not treated as stale next time');
});

test('forgetting is clean, for someone who is on both', () => {
  m.rememberService(1006, 1, 'told');
  m.forgetService(1006);
  assert.equal(m.recallServiceNumber(1006), null);
});

test('a nonsense service number is never stored', () => {
  assert.equal(m.rememberService(1007, 0, 'told'), false);
  assert.equal(m.rememberService(1007, 3, 'told'), false);
  assert.equal(m.rememberService(null, 1, 'told'), false);
  assert.equal(m.recallServiceNumber(1007), null);
});

test('the service is still known days and months later, and after a restart', async () => {
  // It lives in a table, not in memory, and nothing prunes it — the retention
  // sweep only touches messages_log and link_codes.
  const { db, now } = await import('../src/db/db.js');
  const { recallService, rememberService } = await import('../src/service-memory.js');
  const DAY = 86400;

  const aged = (uid, days, service) => {
    rememberService(uid, service, 'told');
    db.prepare('UPDATE tg_service SET updated_at = ? WHERE tg_user_id = ?').run(now() - days * DAY, uid);
  };
  aged(80001, 3, 2);
  aged(80002, 30, 1);
  aged(80003, 200, 2);

  assert.equal(recallService(80001)?.service, 2, 'three days later');
  assert.equal(recallService(80002)?.service, 1, 'a month later');
  // Never expires on READ. The 120-day line only decides whether weaker
  // evidence is allowed to overwrite it.
  assert.equal(recallService(80003)?.service, 2, 'two hundred days later');
});

test('a weak signal corrects a stale record but not a fresh one', async () => {
  const { db, now } = await import('../src/db/db.js');
  const { recallService, rememberService } = await import('../src/service-memory.js');

  rememberService(80010, 1, 'told');
  rememberService(80010, 2, 'guess');
  assert.equal(recallService(80010).service, 1, 'a fresh answer is not overruled by a guess');

  db.prepare('UPDATE tg_service SET updated_at = ? WHERE tg_user_id = ?').run(now() - 200 * 86400, 80010);
  rememberService(80010, 2, 'guess');
  assert.equal(recallService(80010).service, 2, 'a two-hundred-day-old one is');

  // Stronger evidence wins whatever its age — this is how an admin fixes it.
  rememberService(80011, 2, 'told');
  rememberService(80011, 1, 'admin');
  assert.equal(recallService(80011).service, 1);
});
