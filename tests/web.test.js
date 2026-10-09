import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-web-'));
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'initial-password-123';

const { db } = await import('../src/db/db.js');
const { bootstrapAdmin } = await import('../src/web/accounts.js');
const { createApp } = await import('../src/web/app.js');

let server;
let base;

before(async () => {
  bootstrapAdmin();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

function cookiesFrom(res, jar = {}) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    jar[k] = v;
  }
  return jar;
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function getWithCsrf(url, jar) {
  const res = await fetch(url, { headers: { cookie: cookieHeader(jar) }, redirect: 'manual' });
  cookiesFrom(res, jar);
  const html = await res.text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  return { res, html, csrf };
}

test('health endpoint responds', async () => {
  const res = await fetch(`${base}/health`);
  assert.deepEqual(await res.json(), { ok: true });
});

test('POST without CSRF token is rejected with 403', async () => {
  const jar = {};
  await getWithCsrf(`${base}/admin/login`, jar); // establish session
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    body: 'username=admin&password=initial-password-123',
    redirect: 'manual',
  });
  assert.equal(res.status, 403);
});

test('wrong password is rejected, right password forces password change', async () => {
  const jar = {};
  const { csrf } = await getWithCsrf(`${base}/admin/login`, jar);
  assert.ok(csrf, 'login page exposes a CSRF token');

  const bad = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    body: `_csrf=${csrf}&username=admin&password=WRONG`,
    redirect: 'manual',
  });
  assert.equal(bad.status, 401);

  const good = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    body: `_csrf=${csrf}&username=admin&password=initial-password-123`,
    redirect: 'manual',
  });
  assert.equal(good.status, 302);
  assert.equal(good.headers.get('location'), '/admin/password');
  cookiesFrom(good, jar);

  // Admin pages redirect to the forced password change until it is done.
  const dash = await fetch(`${base}/admin`, { headers: { cookie: cookieHeader(jar) }, redirect: 'manual' });
  assert.equal(dash.status, 302);
  assert.equal(dash.headers.get('location'), '/admin/password');
});

test('unauthenticated admin and portal pages redirect to login', async () => {
  for (const [url, target] of [
    [`${base}/admin`, '/admin/login'],
    [`${base}/admin/files`, '/admin/login'],
    [`${base}/admin/conversations`, '/admin/login'],
    [`${base}/admin/conversations/export.jsonl`, '/admin/login'],
    [`${base}/portal`, '/login'],
    [`${base}/portal/download/1/x.apk`, '/login'],
  ]) {
    const res = await fetch(url, { redirect: 'manual' });
    assert.equal(res.status, 302, url);
    assert.equal(res.headers.get('location'), target, url);
  }
});

test('login works even when an upstream proxy adds X-Forwarded-For', async () => {
  const jar = {};
  const { csrf } = await getWithCsrf(`${base}/login`, jar);
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
      'x-forwarded-for': '203.0.113.7',
    },
    body: `_csrf=${csrf}&username=nobody&password=whatever`,
    redirect: 'manual',
  });
  // Must be an auth rejection, not a rate-limiter 500 (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
  assert.equal(res.status, 401);
});

test('invalid short download code shows friendly page, not a crash', async () => {
  const res = await fetch(`${base}/d/NOPE99`);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /isn't valid/);
});

test('customer login is lockout-protected after repeated failures', async () => {
  const { db } = await import('../src/db/db.js');
  const { hashPassword } = await import('../src/web/accounts.js');
  db.prepare("INSERT INTO customers (username, password_hash, active, created_at) VALUES ('locky', ?, 1, 0)")
    .run(hashPassword('correct-pw-123'));

  const jar = {};
  let lastText = '';
  for (let i = 0; i < 6; i++) {
    const { csrf } = await getWithCsrf(`${base}/login`, jar);
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      body: `_csrf=${csrf}&username=locky&password=WRONG`,
      redirect: 'manual',
    });
    lastText = await res.text();
  }
  assert.match(lastText, /locked/i);

  // Even the correct password is refused while locked.
  const { csrf } = await getWithCsrf(`${base}/login`, jar);
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    body: `_csrf=${csrf}&username=locky&password=correct-pw-123`,
    redirect: 'manual',
  });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /locked/i);
});

// ---- authenticated admin routes ---------------------------------------------
// Logging in is only half of it: the first login forces a password change and
// every admin page redirects back to it until that is done.
let adminJar = null;
async function adminSession() {
  // The forced password change can only happen once, so the session is built
  // on first use and shared — calling this twice would try to log in with a
  // password that no longer exists and leave an unauthenticated jar behind.
  if (adminJar) return adminJar;
  const jar = {};
  const { csrf } = await getWithCsrf(`${base}/admin/login`, jar);
  const login = await fetch(`${base}/admin/login`, {
    method: 'POST',
    body: `_csrf=${csrf}&username=admin&password=initial-password-123`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    redirect: 'manual',
  });
  cookiesFrom(login, jar);

  const { csrf: pwCsrf } = await getWithCsrf(`${base}/admin/password`, jar);
  const changed = await fetch(`${base}/admin/password`, {
    method: 'POST',
    body: `_csrf=${pwCsrf}&current_password=initial-password-123&new_password=brand-new-password-1&confirm_password=brand-new-password-1`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    redirect: 'manual',
  });
  cookiesFrom(changed, jar);
  adminJar = jar;
  return jar;
}

test('an admin can link a customer to a Telegram ID by hand', async () => {
  const jar = await adminSession();
  db.prepare("INSERT INTO customers (username, password_hash, active, created_at) VALUES ('linkme', 'x', 1, 0)").run();
  const c = db.prepare("SELECT id FROM customers WHERE username = 'linkme'").get();

  const { csrf } = await getWithCsrf(`${base}/admin/customers/${c.id}`, jar);
  assert.ok(csrf, 'the customer page is reachable once the password is changed');

  const res = await fetch(`${base}/admin/customers/${c.id}/link`, {
    method: 'POST',
    body: `_csrf=${csrf}&telegramUserId=556677`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(db.prepare('SELECT telegram_user_id t FROM customers WHERE id = ?').get(c.id).t, 556677);
});

test('a non-numeric Telegram ID is refused, not written', async () => {
  const jar = await adminSession();
  db.prepare("INSERT INTO customers (username, password_hash, active, created_at) VALUES ('badid', 'x', 1, 0)").run();
  const c = db.prepare("SELECT id FROM customers WHERE username = 'badid'").get();
  const { csrf } = await getWithCsrf(`${base}/admin/customers/${c.id}`, jar);

  const res = await fetch(`${base}/admin/customers/${c.id}/link`, {
    method: 'POST',
    body: `_csrf=${csrf}&telegramUserId=${encodeURIComponent('@someone')}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(db.prepare('SELECT telegram_user_id t FROM customers WHERE id = ?').get(c.id).t, null);
});

test('reusing a Telegram ID already linked elsewhere is refused, not a 500', async () => {
  const jar = await adminSession();
  db.prepare("INSERT INTO customers (username, password_hash, active, created_at, telegram_user_id) VALUES ('owner', 'x', 1, 0, 998877)").run();
  db.prepare("INSERT INTO customers (username, password_hash, active, created_at) VALUES ('thief', 'x', 1, 0)").run();
  const thief = db.prepare("SELECT id FROM customers WHERE username = 'thief'").get();
  const { csrf } = await getWithCsrf(`${base}/admin/customers/${thief.id}`, jar);

  const res = await fetch(`${base}/admin/customers/${thief.id}/link`, {
    method: 'POST',
    body: `_csrf=${csrf}&telegramUserId=998877`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    redirect: 'manual',
  });
  // The UNIQUE constraint would throw a 500 without the explicit guard, and
  // stealing the id would silently kill the other customer's expiry reminders.
  assert.equal(res.status, 302, 'refused cleanly rather than crashing');
  assert.equal(db.prepare('SELECT telegram_user_id t FROM customers WHERE id = ?').get(thief.id).t, null);
  assert.equal(
    db.prepare("SELECT telegram_user_id t FROM customers WHERE username = 'owner'").get().t,
    998877,
    'the original owner keeps the link'
  );
});

// Nothing else in the suite renders the bot-settings or reports pages, so a
// typo'd template variable in either would only show up as a 500 in front of
// the admin. These two fetch them and round-trip the new fields.
test('the bot settings and reports pages render, and the new replies save', async () => {
  const jar = await adminSession();

  const bot = await getWithCsrf(`${base}/admin/bot`, jar);
  assert.equal(bot.res.status, 200, 'bot settings page renders');
  assert.ok(bot.html.includes('helpAskMessage'), 'the bare-ask-for-help reply is editable');
  assert.ok(bot.html.includes('frustrationMessage'), 'the frustration reply is editable');
  assert.ok(bot.html.includes('frustrationRepeatMessage'), 'and the line for the rest of the rant');
  assert.ok(bot.html.includes('botAdmissionMessage'), 'and the "are you a bot" opener');
  // Three customer-facing lines had no field at all — one of them added in
  // this same run of work. A reply nobody can edit is a reply nobody owns.
  assert.ok(bot.html.includes('problemAlreadyFlaggedNote'), 'the already-flagged reply is editable');
  assert.ok(bot.html.includes('busyProblemMessage'), 'and the too-busy-to-troubleshoot reply');
  assert.ok(bot.html.includes('noListingMessage'), 'and the no-listing reply');

  const reports = await getWithCsrf(`${base}/admin/reports`, jar);
  assert.equal(reports.res.status, 200, 'reports page renders');
  assert.ok(reports.html.includes('alertFrustrated'), 'the upset-customer alert has a toggle');
});
