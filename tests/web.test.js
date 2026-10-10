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

// Customer sign-in ships OFF (portal.customerLogin), so the tests that
// exercise the sign-in path switch it on for their own duration. The default
// state has tests of its own further down.
async function withPortalLogin(fn) {
  const { setSetting } = await import('../src/settings.js');
  setSetting('portal.customerLogin', true);
  try {
    await fn();
  } finally {
    setSetting('portal.customerLogin', false);
  }
}

test('unauthenticated admin and portal pages redirect to login', async () => {
  await withPortalLogin(async () => {
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
});

test('login works even when an upstream proxy adds X-Forwarded-For', async () => {
  await withPortalLogin(async () => {
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
});

// ---- customer sign-in switched off (the default) -----------------------------

test('with customer sign-in off there is no login form and no portal', async () => {
  for (const url of [
    `${base}/`,
    `${base}/login`,
    `${base}/portal`,
    `${base}/portal/guides`,
    `${base}/portal/guides/anything`,
    `${base}/portal/account`,
    `${base}/portal/download/1/x.apk`,
  ]) {
    const res = await fetch(url, { redirect: 'manual' });
    const html = await res.text();
    // Either the page itself (/, /login) or a refusal (/portal/*) — never a
    // redirect to a sign-in page that is not there.
    assert.ok([200, 403].includes(res.status), `${url} -> ${res.status}`);
    assert.match(html, /Support happens on Telegram/, url);
    assert.doesNotMatch(html, /type="password"/, url);
  }
});

test('with sign-in off, posting at /login never touches the account', async () => {
  const { hashPassword } = await import('../src/web/accounts.js');
  db.prepare("INSERT INTO customers (username, password_hash, active, created_at) VALUES ('shut', ?, 1, 0)")
    .run(hashPassword('correct-pw-123'));

  // A real CSRF token, so what refuses the request is the switch and not the
  // token check — otherwise this test would pass even with the gate removed.
  const jar = {};
  const { csrf } = await getWithCsrf(`${base}/admin/login`, jar);
  for (const password of ['WRONG', 'WRONG', 'WRONG', 'correct-pw-123']) {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
      body: `_csrf=${csrf}&username=shut&password=${password}`,
      redirect: 'manual',
    });
    assert.equal(res.status, 403);
    // No session was handed out, right password or wrong.
    assert.equal(res.headers.get('location'), null);
  }

  // The whole point of refusing before attemptLogin: an open form posted at
  // by a bot would otherwise lock real customers out and fill the audit log.
  const row = db.prepare("SELECT failed_attempts, locked_until, last_login_at FROM customers WHERE username = 'shut'").get();
  assert.equal(row.failed_attempts, 0);
  assert.equal(row.locked_until, null);
  assert.equal(row.last_login_at, null);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'customer.login%' AND actor = 'shut'").get().n,
    0
  );
});

test('short download codes still work with sign-in off', async () => {
  const { config } = await import('../src/config.js');
  fs.writeFileSync(path.join(config.uploadsDir, 'stored-test.apk'), 'APKBYTES');
  db.prepare(`INSERT INTO files (stored_name, display_name, original_name, size, sha256, visible, is_latest, uploaded_at)
              VALUES ('stored-test.apk', 'Test App', 'test.apk', 8, 'deadbeef', 1, 1, 0)`).run();
  const fileId = db.prepare("SELECT id FROM files WHERE stored_name = 'stored-test.apk'").get().id;
  db.prepare(`INSERT INTO download_codes (code, file_id, max_uses, expires_at, created_at)
              VALUES ('ABC123', ?, 3, ?, 0)`).run(fileId, Math.floor(Date.now() / 1000) + 3600);

  // This is the path a Firestick actually uses: the code typed into the
  // Downloader app, no login, nothing to sign into. Closing the portal must
  // not close this.
  const res = await fetch(`${base}/d/ABC123`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'APKBYTES');
  assert.equal(db.prepare("SELECT uses FROM download_codes WHERE code = 'ABC123'").get().uses, 1);
});

test('invalid short download code shows friendly page, not a crash', async () => {
  const res = await fetch(`${base}/d/NOPE99`);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /isn't valid/);
});

test('customer login is lockout-protected after repeated failures', async () => {
  await withPortalLogin(async () => {
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
});

test('a session already open is closed the moment sign-in is switched off', async () => {
  const { setSetting } = await import('../src/settings.js');
  const { hashPassword } = await import('../src/web/accounts.js');
  db.prepare("INSERT INTO customers (username, password_hash, active, created_at) VALUES ('midway', ?, 1, 0)")
    .run(hashPassword('correct-pw-123'));

  const jar = {};
  setSetting('portal.customerLogin', true);
  const { csrf } = await getWithCsrf(`${base}/login`, jar);
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    body: `_csrf=${csrf}&username=midway&password=correct-pw-123`,
    redirect: 'manual',
  });
  cookiesFrom(login, jar);
  assert.equal(login.headers.get('location'), '/portal');

  const before = await fetch(`${base}/portal`, { headers: { cookie: cookieHeader(jar) }, redirect: 'manual' });
  assert.equal(before.status, 200);

  // Flipping the switch has to shut the door on whoever is already inside,
  // not just on the next person to knock.
  setSetting('portal.customerLogin', false);
  const after = await fetch(`${base}/portal`, { headers: { cookie: cookieHeader(jar) }, redirect: 'manual' });
  assert.equal(after.status, 403);
  assert.match(await after.text(), /Support happens on Telegram/);
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

// Every page in the panel, fetched once. The chrome around them — the
// sidebar, the counts beside each menu item, the bar across the top — is
// built from locals set by one middleware, and a page that renders without
// those locals does not fail quietly: EJS throws and the admin gets a 500.
// Six pages had no coverage at all before this, so the sweep is cheap
// insurance against exactly the kind of mistake a chrome change makes.
test('every page in the admin panel renders', async () => {
  const jar = await adminSession();
  // A guide and a file so the edit pages have something to open.
  db.prepare("INSERT INTO guides (title, slug, body_md, visible, sort, updated_at) VALUES ('Sweep', 'sweep', '# hi', 1, 0, 0)").run();
  const guideId = db.prepare("SELECT id FROM guides WHERE slug = 'sweep'").get().id;
  const customerId = db.prepare('SELECT id FROM customers ORDER BY id LIMIT 1').get().id;

  for (const url of [
    '/admin',
    '/admin/problems',
    '/admin/requests',
    '/admin/unanswered',
    '/admin/conversations',
    '/admin/faqs',
    '/admin/faqs/review',
    '/admin/guides',
    '/admin/guides/new',
    `/admin/guides/${guideId}`,
    '/admin/files',
    '/admin/customers',
    '/admin/customers?filter=expiring',
    `/admin/customers/${customerId}`,
    '/admin/broadcasts',
    '/admin/settings',
    '/admin/bot',
    '/admin/ai',
    '/admin/reports',
    '/admin/system',
    '/admin/admins',
    '/admin/audit',
    '/admin/password',
  ]) {
    const res = await fetch(`${base}${url}`, { headers: { cookie: cookieHeader(jar) }, redirect: 'manual' });
    const html = await res.text();
    assert.equal(res.status, 200, `${url} -> ${res.status}`);
    assert.ok(html.includes('class="sidebar"'), `${url} has the menu`);
    assert.ok(html.includes('topbar-where'), `${url} has the bar across the top`);
  }
});

test('the menu marks the current page, and counts only show when non-zero', async () => {
  const jar = await adminSession();

  const quiet = await getWithCsrf(`${base}/admin/system`, jar);
  assert.ok(quiet.html.includes('class="nav active" href="/admin/system"'), 'the page you are on is marked');
  assert.ok(!quiet.html.includes('class="nav active" href="/admin"'), 'and no other page is');
  assert.ok(!quiet.html.includes('nav-count'), 'nothing is waiting, so no counts are drawn');

  db.prepare(`INSERT INTO problem_reports (chat_id, tg_user_id, tg_user, topic, text, resolved, ts)
              VALUES (1, 2, 'someone', 'buffering', 'it keeps buffering', 0, 0)`).run();
  const busy = await getWithCsrf(`${base}/admin/system`, jar);
  assert.ok(busy.html.includes('nav-count'), 'an open report puts a count in the menu');
  assert.match(busy.html, /href="\/admin\/problems"[\s\S]{0,200}nav-count">1</, 'against Problem reports');
});

// The panel offers this file as "safe to share", so that claim needs a test
// rather than a careful SELECT and good intentions. The database it is read
// from holds the Xtream lookup password, the panel URL, the bot token,
// wallet addresses, every customer and every message; the export is
// channel names, programme titles and times.
test('the lineup export carries the lineup and none of the secrets', async () => {
  const jar = await adminSession();
  const { setSetting } = await import('../src/settings.js');

  // Plant distinctive values everywhere a secret actually lives, so a leak
  // shows up as an exact string rather than a judgement call.
  setSetting('services.url1', 'https://panel.example.invalid');
  setSetting('services.xcUser1', 'LOOKUPUSER-CANARY');
  setSetting('services.xcPass1', 'LOOKUPPASS-CANARY');
  setSetting('payments.ltcAddress', 'LTCWALLET-CANARY');
  setSetting('bot.adminContact', '@AdminCanary');
  db.prepare("INSERT INTO customers (username, password_hash, active, created_at) VALUES ('CUSTOMER-CANARY', 'HASH-CANARY', 1, 0)").run();
  db.prepare('DELETE FROM xc_channels').run();
  db.prepare("INSERT INTO xc_channels (service, stream_id, name, category, epg_channel_id, updated_at) VALUES (1, 991, 'UK: Sky Sports Main Event HD', 'UK | SPORTS', 'ssme', 1)").run();
  const soon = Math.floor(Date.now() / 1000) + 1800;
  db.prepare('INSERT INTO xc_programmes (service, channel_id, title, start_ts, stop_ts) VALUES (1, ?, ?, ?, ?)')
    .run('ssme', 'Boxing: Fury v Usyk II', soon, soon + 10800);

  const res = await fetch(`${base}/admin/system/lineup.json`, {
    headers: { cookie: cookieHeader(jar) }, redirect: 'manual',
  });
  assert.equal(res.status, 200);
  const body = await res.text();

  // It has to be worth downloading.
  const data = JSON.parse(body);
  assert.match(JSON.stringify(data.channels), /Sky Sports Main Event/, 'the lineup is in it');
  assert.match(JSON.stringify(data.programmes), /Fury v Usyk/, 'and the guide');

  for (const canary of [
    'LOOKUPUSER-CANARY', 'LOOKUPPASS-CANARY', 'LTCWALLET-CANARY',
    'CUSTOMER-CANARY', 'HASH-CANARY', 'panel.example.invalid', 'AdminCanary',
  ]) {
    assert.ok(!body.includes(canary), `the export leaked ${canary}`);
  }

  // And it is admin-only, like everything else under /admin.
  const out = await fetch(`${base}/admin/system/lineup.json`, { redirect: 'manual' });
  assert.equal(out.status, 302, 'signed out, it redirects to the login');

  db.prepare('DELETE FROM xc_programmes').run();
  db.prepare('DELETE FROM xc_channels').run();
  db.prepare("DELETE FROM customers WHERE username = 'CUSTOMER-CANARY'").run();
  setSetting('services.xcUser1', '');
  setSetting('services.xcPass1', '');
  setSetting('bot.adminContact', '');
});
