// Export the cached lineup and TV guide, and nothing else.
//
//   npm run export-lineup          (writes lineup.json next to the database)
//
// What this is for: the bot's answers about channels and fixtures are only
// as good as what it finds in its own cache, and a test lineup invented by
// hand does not have the shapes a real panel produces — the "UK: " prefixes,
// the HD suffixes, "Premier League: Derby County v Leeds United" where the
// customer typed "football", two services whose channel names differ by a
// word. Testing against the real thing finds the questions that only fail on
// the real thing.
//
// What it deliberately does NOT export: the settings table (your panel URL,
// lookup username and password, wallet addresses, bot token), customers,
// messages, audit log, problem reports, admins, sessions. It reads two
// tables, and it reads only the columns below. Nothing here identifies a
// person or opens a door.
//
// The file is safe to share. Read it first if you like — it is plain JSON.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = process.env.DATA_DIR
  || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
const dbFile = path.join(dataDir, 'app.db');

if (!fs.existsSync(dbFile)) {
  console.error(`No database at ${dbFile}. Set DATA_DIR if yours lives elsewhere.`);
  process.exit(1);
}

const db = new Database(dbFile, { readonly: true });

const channels = db.prepare(`
  SELECT service, name, category, epg_channel_id
  FROM xc_channels ORDER BY service, category, name
`).all();

// Titles and times only. The channel is referenced by its guide id, which is
// already in the channel list above.
const programmes = db.prepare(`
  SELECT service, channel_id, title, start_ts, stop_ts
  FROM xc_programmes WHERE stop_ts > ? ORDER BY start_ts LIMIT 4000
`).all(Math.floor(Date.now() / 1000) - 3600);

// VOD names only — no stream ids, no urls.
let vod = [];
try {
  vod = db.prepare('SELECT service, name FROM xc_vod ORDER BY service, name LIMIT 4000').all();
} catch { /* older installs may not have it */ }

db.close();

const out = {
  exportedAt: new Date().toISOString(),
  note: 'Cached lineup and guide only. No settings, credentials, customers or messages.',
  channels,
  programmes,
  vod,
};

const target = path.join(dataDir, 'lineup.json');
fs.writeFileSync(target, JSON.stringify(out, null, 1));

const perService = (rows) => [1, 2].map((n) => `${n}: ${rows.filter((r) => r.service === n).length}`).join('  ');
console.log(`Wrote ${target}`);
console.log(`  channels   ${channels.length}   (service ${perService(channels)})`);
console.log(`  programmes ${programmes.length}   (service ${perService(programmes)})`);
console.log(`  vod        ${vod.length}   (service ${perService(vod)})`);
if (!channels.length) {
  console.log('\nThe cache is empty — the panel has not been read yet.');
  console.log('Send the bot /channels refresh (and /guide refresh for the TV guide)');
  console.log('as an admin, then run this again.');
}
