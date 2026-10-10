import { db } from './db/db.js';
import { now } from './db/db.js';

// The cached lineup and TV guide, and nothing else.
//
// Shared by the panel's download button and tools/export-lineup.mjs so there
// is one definition of what leaves the building. The list of columns below
// IS the safety guarantee, so it is deliberately written out rather than
// assembled: no SELECT *, no table taken wholesale, nothing that could grow
// a sensitive column later without someone editing this line.
//
// Not included, and not reachable from here: the settings table (panel URL,
// Xtream lookup username and password, wallet addresses, bot token, API
// keys), customers, messages, the audit log, problem reports, admins,
// sessions, download codes. Channel names, programme titles and times
// identify nobody and open nothing.
export function exportLineup({ limit = 4000 } = {}) {
  const channels = db.prepare(`
    SELECT service, name, category, epg_channel_id
    FROM xc_channels ORDER BY service, category, name
  `).all();

  const programmes = db.prepare(`
    SELECT service, channel_id, title, start_ts, stop_ts
    FROM xc_programmes WHERE stop_ts > ? ORDER BY start_ts LIMIT ?
  `).all(now() - 3600, limit);

  let vod = [];
  try {
    vod = db.prepare('SELECT service, name FROM xc_vod ORDER BY service, name LIMIT ?').all(limit);
  } catch {
    // Older installs may not have the table yet.
  }

  return {
    exportedAt: new Date().toISOString(),
    note: 'Cached lineup and TV guide only. No settings, credentials, customers or messages.',
    channels,
    programmes,
    vod,
  };
}
