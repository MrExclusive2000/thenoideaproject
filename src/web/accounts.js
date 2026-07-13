import bcrypt from 'bcryptjs';
import { db, now } from '../db/db.js';
import { config } from '../config.js';
import { randomPassword } from '../util.js';

const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}

// Create the first admin from env vars on boot. Never interactive: if no
// password was provided, generate one and print it to the (Pelican) console.
export function bootstrapAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (count > 0) return;
  const username = config.initialAdmin.username || 'admin';
  const password = config.initialAdmin.password || randomPassword(14);
  db.prepare(
    'INSERT INTO admins (username, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, 1, ?)'
  ).run(username, hashPassword(password), 'owner', now());
  console.log('==============================================================');
  console.log(` First admin account created — username: ${username}`);
  if (!config.initialAdmin.password) {
    console.log(` Generated password: ${password}`);
    console.log(' (set the ADMIN_PASSWORD variable to choose your own)');
  }
  console.log(' You will be asked to change the password at first login.');
  console.log('==============================================================');
}

// Shared login-with-lockout for admins and customers. Returns
// { ok, account } or { ok: false, reason: 'locked' | 'invalid' }.
export function attemptLogin(table, username, password) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE username = ?`).get(String(username || '').trim());
  const t = now();

  if (!row) {
    bcrypt.compareSync(String(password || ''), '$2b$12$C6UzMDM.H6dfI/f/IKcEeO7ZWbYVZ5EnqlDBLKcqvHYBAmSVEqx2a'); // constant-time-ish
    return { ok: false, reason: 'invalid' };
  }
  if (row.locked_until && row.locked_until > t) return { ok: false, reason: 'locked' };

  if (!bcrypt.compareSync(String(password || ''), row.password_hash)) {
    const fails = (row.failed_attempts || 0) + 1;
    const locked = fails >= MAX_FAILS ? t + LOCK_SECONDS : null;
    db.prepare(`UPDATE ${table} SET failed_attempts = ?, locked_until = ? WHERE id = ?`).run(fails, locked, row.id);
    return { ok: false, reason: locked ? 'locked' : 'invalid' };
  }

  db.prepare(`UPDATE ${table} SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?`).run(t, row.id);
  return { ok: true, account: row };
}
