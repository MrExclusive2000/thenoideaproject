import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-web-'));
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'initial-password-123';

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
    [`${base}/portal`, '/login'],
    [`${base}/portal/download/1/x.apk`, '/login'],
  ]) {
    const res = await fetch(url, { redirect: 'manual' });
    assert.equal(res.status, 302, url);
    assert.equal(res.headers.get('location'), target, url);
  }
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
