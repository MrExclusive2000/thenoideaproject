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

const dataDir = process.env.DATA_DIR
  || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
process.env.DATA_DIR = dataDir;

if (!fs.existsSync(path.join(dataDir, 'app.db'))) {
  console.error(`No database at ${path.join(dataDir, 'app.db')}. Set DATA_DIR if yours lives elsewhere.`);
  process.exit(1);
}

const { exportLineup } = await import('../src/lineup-export.js');
const out = exportLineup();

const target = path.join(dataDir, 'lineup.json');
fs.writeFileSync(target, JSON.stringify(out, null, 1));

const perService = (rows) => [1, 2].map((n) => `${n}: ${rows.filter((r) => r.service === n).length}`).join('  ');
console.log(`Wrote ${target}`);
console.log(`  channels   ${out.channels.length}   (service ${perService(out.channels)})`);
console.log(`  programmes ${out.programmes.length}   (service ${perService(out.programmes)})`);
console.log(`  vod        ${out.vod.length}   (service ${perService(out.vod)})`);
if (!out.channels.length) {
  console.log('\nThe cache is empty — the panel has not been read yet.');
  console.log('Send the bot /channels refresh (and /guide refresh for the TV guide)');
  console.log('as an admin, then run this again.');
}
