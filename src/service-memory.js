import { db, now } from './db/db.js';

// Which service a Telegram user is on, remembered between restarts.
//
// The hard part is not storing it — it is knowing when to believe it. Two
// rules do the work:
//
//  * Naming a service in a QUESTION is not a statement of identity. Someone
//    on Flix can perfectly well ask "is Big Bang Theory on Exclusive?" and
//    pinning them to Exclusive for it would be wrong for every answer after.
//    Only an answer to "which service are you on?", a username, or an admin
//    saying so is evidence about the person.
//
//  * People move. A renewal that switches someone between services has to be
//    able to overwrite what we think, so stronger or newer evidence always
//    wins rather than the first answer sticking forever.

// How much each kind of evidence is worth. A username beats a guess; an
// admin saying so beats everything, because they are looking at the account.
const WEIGHT = { guess: 1, told: 2, username: 3, linked: 4, admin: 5 };

// Even the strongest evidence goes stale: people renew onto the other
// service, and nobody comes back to tell the bot. After this, the next
// stronger-or-equal signal replaces it without argument.
const STALE_DAYS = 120;

export function recallService(tgUserId) {
  if (!tgUserId) return null;
  const row = db.prepare('SELECT * FROM tg_service WHERE tg_user_id = ?').get(tgUserId);
  return row || null;
}

export const recallServiceNumber = (tgUserId) => recallService(tgUserId)?.service ?? null;

// Returns true when the stored answer changed.
export function rememberService(tgUserId, service, source = 'told', username = null) {
  if (!tgUserId || (service !== 1 && service !== 2)) return false;
  const weight = WEIGHT[source] ?? 1;
  const existing = recallService(tgUserId);

  if (existing) {
    const prior = WEIGHT[existing.source] ?? 1;
    const stale = now() - existing.updated_at > STALE_DAYS * 86400;
    // Weaker evidence never overwrites stronger evidence — unless the
    // stronger evidence has had time to go out of date, which is exactly
    // what happens when someone renews onto the other service.
    if (weight < prior && !stale) return false;
    // Same service, same strength: just refresh the clock.
    if (existing.service === service) {
      db.prepare('UPDATE tg_service SET source = ?, username = COALESCE(?, username), updated_at = ? WHERE tg_user_id = ?')
        .run(weight >= prior ? source : existing.source, username, now(), tgUserId);
      return false;
    }
  }

  db.prepare(
    'INSERT INTO tg_service (tg_user_id, service, source, username, updated_at) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(tg_user_id) DO UPDATE SET service = excluded.service, source = excluded.source, ' +
    'username = COALESCE(excluded.username, tg_service.username), updated_at = excluded.updated_at'
  ).run(tgUserId, service, source, username, now());
  return !existing || existing.service !== service;
}

export function forgetService(tgUserId) {
  db.prepare('DELETE FROM tg_service WHERE tg_user_id = ?').run(tgUserId);
}

export function serviceMemoryStats() {
  const rows = db.prepare('SELECT service, COUNT(*) n FROM tg_service GROUP BY service').all();
  const by = { 1: 0, 2: 0 };
  for (const r of rows) by[r.service] = r.n;
  return by;
}
