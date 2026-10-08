import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-xc-'));

const { db } = await import('../src/db/db.js');
const { setSetting } = await import('../src/settings.js');
const xc = await import('../src/xc.js');

let panel;
let streams = [
  { stream_id: 101, name: 'UK: Sky Sports F1 HD', category_id: '1', epg_channel_id: 'skyf1.uk' },
  { stream_id: 102, name: 'UK: Sky Sports Main Event', category_id: '1' },
  { stream_id: 103, name: 'UK: TNT Sports 1', category_id: '1' },
  { stream_id: 201, name: 'UK: BBC One HD', category_id: '2' },
];

let xmltvGzip = false;
// Times carry an offset, which is what makes them safe to compare against our
// own clock. Built relative to now so "tonight" is meaningful whenever the
// suite runs.
const xmlStamp = (offsetSeconds) => {
  const d = new Date((Math.floor(Date.now() / 1000) + offsetSeconds) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
};
function xmltvBody() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="skyf1.uk"><display-name>Sky Sports F1</display-name></channel>
  <programme start="${xmlStamp(1800)}" stop="${xmlStamp(9000)}" channel="skyf1.uk">
    <title lang="en">Formula 1: Qatar Grand Prix</title>
    <desc lang="en">Live coverage</desc>
  </programme>
  <programme start="${xmlStamp(3600)}" stop="${xmlStamp(10800)}" channel="skysports.main">
    <title lang="en"><![CDATA[Derby County v Leeds United]]></title>
  </programme>
  <programme start="${xmlStamp(7200)}" stop="${xmlStamp(12000)}" channel="tnt1.uk">
    <title lang="en">Arsenal &amp; Chelsea: Match of the Day</title>
  </programme>
  <programme start="${xmlStamp(-7 * 86400)}" stop="${xmlStamp(-7 * 86400 + 3600)}" channel="skyf1.uk">
    <title lang="en">Last week: Mexican Grand Prix</title>
  </programme>
  <programme start="${xmlStamp(20 * 86400)}" stop="${xmlStamp(20 * 86400 + 3600)}" channel="skyf1.uk">
    <title lang="en">Next month: Abu Dhabi Grand Prix</title>
  </programme>
</tv>`;
}

let vodStreams = [
  { name: 'Oppenheimer (2023) 4K', category_id: '10' },
  { name: 'The Batman [2022] IMAX', category_id: '10' },
  { name: 'Up', category_id: '11' },
];
let vodSeries = [{ name: 'Severance', category_id: '20' }];

let seenPasswords = [];
let calls = [];
let epgListings = null; // null = the panel's default single listing
let epgStop = 0; // panel-reported stop_timestamp, 0 = omit it

before(async () => {
  panel = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seenPasswords.push(u.searchParams.get('password'));
    calls.push(u.pathname.endsWith('/xmltv.php') ? 'xmltv' : u.searchParams.get('action'));
    if (u.pathname.endsWith('/xmltv.php')) {
      if (u.searchParams.get('password') !== 'rightpw') { res.statusCode = 401; return res.end('no'); }
      const body = Buffer.from(xmltvBody(), 'utf8');
      res.setHeader('content-type', 'application/xml');
      // Panels commonly serve gzip BYTES with no content-encoding header, so
      // fetch hands them over still compressed.
      return res.end(xmltvGzip ? zlib.gzipSync(body) : body);
    }
    res.setHeader('content-type', 'application/json');
    // A wrong password answers 200 with auth:0, not an error status — a bad
    // login looks exactly like a successful one unless you check for it.
    if (u.searchParams.get('password') !== 'rightpw') {
      return res.end(JSON.stringify({ user_info: { auth: 0 } }));
    }
    const action = u.searchParams.get('action');
    if (action === 'get_live_categories') {
      return res.end(JSON.stringify([
        { category_id: '1', category_name: 'UK | SPORTS' },
        { category_id: '2', category_name: 'UK | ENTERTAINMENT' },
      ]));
    }
    if (action === 'get_live_streams') return res.end(JSON.stringify(streams));
    if (action === 'get_vod_streams') return res.end(JSON.stringify(vodStreams));
    if (action === 'get_series') return res.end(JSON.stringify(vodSeries));
    if (action === 'get_short_epg') {
      if (epgListings) return res.end(JSON.stringify({ epg_listings: epgListings }));
      return res.end(JSON.stringify({ epg_listings: [{
        title: Buffer.from('Formula 1: Qatar Grand Prix').toString('base64'),
        description: Buffer.from('Live coverage').toString('base64'),
        start: '2026-10-07 18:00:00', end: '2026-10-07 20:00:00',
        ...(epgStop ? { stop_timestamp: String(epgStop) } : {}),
      }] }));
    }
    res.end('{}');
  });
  await new Promise((r) => panel.listen(0, '127.0.0.1', r));
  setSetting('services.url1', `http://127.0.0.1:${panel.address().port}`);
  setSetting('services.xcUser1', 'lookup');
  setSetting('services.xcPass1', 'rightpw');
});

after(() => {
  panel?.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('the lineup is pulled and cached with its categories', async () => {
  const r = await xc.refreshChannels(1);
  assert.equal(r.ok, true);
  assert.equal(r.count, 4);
  const row = db.prepare("SELECT * FROM xc_channels WHERE name LIKE '%F1%'").get();
  assert.equal(row.category, 'UK | SPORTS', 'the category name is resolved, not left as an id');
  assert.equal(row.stream_id, 101);
});

test('channels dropped from the lineup are removed, not left to be recommended', async () => {
  streams = streams.filter((s) => s.stream_id !== 103); // TNT Sports pulled
  try {
    await xc.refreshChannels(1);
    assert.equal(xc.channelCount(1), 3);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM xc_channels WHERE name LIKE '%TNT%'").get().n, 0,
      'sending someone to a channel that no longer exists is worse than not answering'
    );
  } finally {
    streams.push({ stream_id: 103, name: 'UK: TNT Sports 1', category_id: '1' });
    await xc.refreshChannels(1);
  }
});

test('a wrong password is detected even though the panel answers 200', async () => {
  setSetting('services.xcPass1', 'wrongpw');
  try {
    const r = await xc.refreshChannels(1);
    assert.equal(r.ok, false);
    assert.match(r.error, /rejected the lookup username or password/);
  } finally {
    setSetting('services.xcPass1', 'rightpw');
  }
});

test('the lookup password never appears in an error', async () => {
  setSetting('services.xcPass1', 'rightpw');
  setSetting('services.url1', 'http://127.0.0.1:1'); // nothing listening
  try {
    const r = await xc.refreshChannels(1);
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error, /rightpw|lookup|127\.0\.0\.1/,
      'the credential rides in the query string, so no error may carry the URL');
  } finally {
    setSetting('services.url1', `http://127.0.0.1:${panel.address().port}`);
    await xc.refreshChannels(1);
  }
});

test('searching the lineup ignores words every channel shares', () => {
  const hits = xc.findChannels('what channel is the f1 on', { service: 1 });
  assert.ok(hits.length, 'found something');
  assert.match(hits[0].name, /F1/, `"uk", "hd" and "channel" must not decide the winner — got ${hits[0].name}`);

  // A question with nothing but noise must match nothing rather than
  // returning the whole lineup.
  assert.equal(xc.findChannels('what channel is on the tv', { service: 1 }).length, 0);
});

test('EPG titles are decoded from base64', async () => {
  const epg = await xc.shortEpg(101, { service: 1 });
  assert.equal(epg.length, 1);
  assert.equal(epg[0].title, 'Formula 1: Qatar Grand Prix');
  assert.equal(epg[0].description, 'Live coverage');
});

test('grounding carries the exact channel names and the guide', async () => {
  const g = await xc.channelGrounding('what channel is the f1 on', { service: 1 });
  assert.match(g, /UK: Sky Sports F1 HD/, 'the exact name, so the bot quotes it correctly');
  assert.match(g, /Qatar Grand Prix/, 'with what is actually on it');
  assert.match(g, /18:00/, 'and the time from the guide');
});

test('grounding is null when no lookup account is set', async () => {
  setSetting('services.xcUser1', '');
  try {
    assert.equal(xc.xcConfigured(1), false);
    assert.equal(await xc.channelGrounding('what channel is the f1 on', { service: 1 }), null);
  } finally {
    setSetting('services.xcUser1', 'lookup');
  }
});

test('a question about something we do not carry grounds nothing', async () => {
  assert.equal(await xc.channelGrounding('what channel is the knitting on', { service: 1 }), null,
    'better to ground nothing than to offer the nearest unrelated channel');
});

// --- the guide is cached, or a busy evening is a call per question ----------

const epgCalls = () => calls.filter((a) => a === 'get_short_epg').length;
const clearEpg = () => db.prepare('DELETE FROM xc_epg').run();

test('a second question about the same channel does not go to the panel', async () => {
  clearEpg();
  calls = [];
  const first = await xc.shortEpg(101, { service: 1 });
  assert.equal(epgCalls(), 1);
  const second = await xc.shortEpg(101, { service: 1 });
  assert.equal(epgCalls(), 1, 'served from the cache');
  assert.deepEqual(second, first, 'and it is the same answer, not a shorter one');
});

test('simultaneous questions about one channel share a single call', async () => {
  clearEpg();
  calls = [];
  const all = await Promise.all([
    xc.shortEpg(101, { service: 1 }),
    xc.shortEpg(101, { service: 1 }),
    xc.shortEpg(101, { service: 1 }),
  ]);
  assert.equal(epgCalls(), 1, 'three questions in the same breath, one call');
  for (const r of all) assert.equal(r[0].title, 'Formula 1: Qatar Grand Prix');
});

test('a channel with no guide is cached too, so it stops being asked about', async () => {
  clearEpg();
  calls = [];
  epgListings = [];
  try {
    assert.deepEqual(await xc.shortEpg(102, { service: 1 }), []);
    assert.deepEqual(await xc.shortEpg(102, { service: 1 }), []);
    assert.equal(epgCalls(), 1, 'an empty guide is an answer, not a cache miss to retry');
  } finally {
    epgListings = null;
  }
});

test('a panel blip serves the cached guide and does not erase it', async () => {
  clearEpg();
  xc._resetXcBackoff();
  await xc.shortEpg(101, { service: 1 });
  const url = `http://127.0.0.1:${panel.address().port}`;
  setSetting('services.url1', 'http://127.0.0.1:1'); // nothing listening
  try {
    const out = await xc.shortEpg(101, { service: 1, force: true });
    assert.equal(out[0]?.title, 'Formula 1: Qatar Grand Prix', 'stale beats nothing');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM xc_epg').get().n, 1, 'cache left intact');
  } finally {
    setSetting('services.url1', url);
    xc._resetXcBackoff();
  }
});

test('a dead panel is not retried on every single question', async () => {
  // Each failure costs the full request timeout, so retrying per question
  // means every customer waits for it before getting an answer without the
  // guide.
  clearEpg();
  xc._resetXcBackoff();
  const url = `http://127.0.0.1:${panel.address().port}`;
  setSetting('services.url1', 'http://127.0.0.1:1'); // nothing listening
  try {
    assert.deepEqual(await xc.shortEpg(101, { service: 1 }), []);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM xc_epg').get().n, 0,
      'and a failure is never cached as "nothing is on"');
  } finally {
    setSetting('services.url1', url);
  }

  // The panel is reachable again, but the pause has not elapsed — a DIFFERENT
  // channel, so nothing per-channel can explain this. Still no call.
  calls = [];
  assert.deepEqual(await xc.shortEpg(102, { service: 1 }), []);
  assert.equal(epgCalls(), 0, 'held off instead of hammering a panel that just failed');

  // ...and the pause is the only thing that was holding it.
  xc._resetXcBackoff();
  const back = await xc.shortEpg(102, { service: 1 });
  assert.equal(back[0]?.title, 'Formula 1: Qatar Grand Prix');
  assert.equal(epgCalls(), 1);
});

test('a finished run expires early instead of waiting out the TTL', async () => {
  clearEpg();
  calls = [];
  epgStop = Math.floor(Date.now() / 1000) - 3600; // the cached run ended an hour ago
  try {
    await xc.shortEpg(101, { service: 1 });
    assert.equal(epgCalls(), 1);
    // Backdate the fetch past the floor that protects against a panel with a
    // broken clock; the run is finished, so it must be refetched.
    db.prepare('UPDATE xc_epg SET fetched_at = fetched_at - 1200').run();
    await xc.shortEpg(101, { service: 1 });
    assert.equal(epgCalls(), 2, 'yesterday’s listing is not an answer');
  } finally {
    epgStop = 0;
  }
});

test('a panel reporting nonsense timestamps still gets cached', async () => {
  clearEpg();
  calls = [];
  epgStop = 1; // epoch 1970 — a broken clock, not a finished programme
  try {
    await xc.shortEpg(101, { service: 1 });
    await xc.shortEpg(101, { service: 1 });
    assert.equal(epgCalls(), 1, 'a bad timestamp must not defeat caching entirely');
  } finally {
    epgStop = 0;
  }
});

test('the TTL is what finally sends us back to the panel', async () => {
  clearEpg();
  calls = [];
  setSetting('services.epgCacheMinutes', 30);
  try {
    await xc.shortEpg(101, { service: 1 });
    db.prepare('UPDATE xc_epg SET fetched_at = fetched_at - ?').run(31 * 60);
    await xc.shortEpg(101, { service: 1 });
    assert.equal(epgCalls(), 2, 'a 30-minute cache is 30 minutes old at most');
  } finally {
    setSetting('services.epgCacheMinutes', 1440); // leave the default as found
  }
});

test('an empty channel list from the panel never wipes a working lineup', async () => {
  const before = xc.channelCount(1);
  assert.ok(before > 0, 'something to lose');
  const kept = streams;
  streams = [];
  try {
    const r = await xc.refreshChannels(1);
    assert.equal(r.ok, false);
    assert.equal(xc.channelCount(1), before,
      'a panel mid-restart must not cost us every channel answer for a day');
  } finally {
    streams = kept;
    await xc.refreshChannels(1);
  }
});

test('the guide cache is pruned of channels that left the lineup', async () => {
  clearEpg();
  await xc.shortEpg(101, { service: 1 });
  db.prepare('INSERT INTO xc_epg (service, stream_id, listings, last_end, fetched_at) VALUES (1, 999, ?, 0, ?)')
    .run('[]', Math.floor(Date.now() / 1000));
  xc.pruneEpgCache();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM xc_epg WHERE stream_id = 999').get().n, 0,
    'no channel, no guide');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM xc_epg WHERE stream_id = 101').get().n, 1,
    'a live channel keeps its guide');
});

test('grounding a repeated question costs nothing after the first', async () => {
  clearEpg();
  calls = [];
  await xc.channelGrounding('what channel is the f1 on', { service: 1 });
  const afterFirst = epgCalls();
  const g = await xc.channelGrounding('what channel is the f1 on', { service: 1 });
  assert.equal(epgCalls(), afterFirst, 'no second call');
  assert.match(g, /Qatar Grand Prix/, 'and the answer is still complete');
});

test('channel questions are told apart from support questions', () => {
  for (const q of ['what channel is the f1 on', 'whats on sky sports main event', 'where can i watch the darts']) {
    assert.equal(xc.looksLikeChannelQuestion(q), true, q);
  }
  for (const q of ['my app keeps buffering', 'how do i install on firestick', 'whats the downloader code']) {
    assert.equal(xc.looksLikeChannelQuestion(q), false, q);
  }
});

// --- the whole guide: questions where the CHANNEL is the answer --------------

async function loadGuide() {
  // Channels first: a programme we cannot name a channel for is no answer.
  db.prepare('DELETE FROM xc_channels').run();
  db.prepare("INSERT INTO xc_channels (service, stream_id, name, category, epg_channel_id, updated_at) VALUES (1, 101, 'UK: Sky Sports F1 HD', 'UK | SPORTS', 'skyf1.uk', 1)").run();
  db.prepare("INSERT INTO xc_channels (service, stream_id, name, category, epg_channel_id, updated_at) VALUES (1, 102, 'UK: Sky Sports Main Event', 'UK | SPORTS', 'skysports.main', 1)").run();
  db.prepare("INSERT INTO xc_channels (service, stream_id, name, category, epg_channel_id, updated_at) VALUES (1, 103, 'UK: TNT Sports 1', 'UK | SPORTS', 'tnt1.uk', 1)").run();
  return xc.refreshGuide(1);
}

test('the full guide downloads, parses and keeps only a window around now', async () => {
  const r = await loadGuide();
  assert.equal(r.ok, true);
  assert.equal(r.scanned, 5, 'every programme in the file was read');
  assert.equal(r.count, 3, 'last week and next month are not what anyone is asking about');
  assert.equal(xc.programmeCount(1), 3);
});

test('a gzipped guide with no content-encoding header is still read', async () => {
  // Panels commonly serve gzip bytes without the header, so fetch hands them
  // over compressed and a naive reader stores a few hundred thousand mojibake.
  xmltvGzip = true;
  try {
    const r = await loadGuide();
    assert.equal(r.ok, true);
    assert.equal(r.count, 3);
    assert.ok(db.prepare("SELECT 1 FROM xc_programmes WHERE title LIKE '%Qatar%'").get(), 'titles survived');
  } finally {
    xmltvGzip = false;
    await loadGuide();
  }
});

test('XML entities and CDATA come out as the real title', () => {
  const titles = db.prepare('SELECT title FROM xc_programmes').all().map((r) => r.title);
  assert.ok(titles.includes('Derby County v Leeds United'), 'CDATA unwrapped');
  assert.ok(titles.includes('Arsenal & Chelsea: Match of the Day'), '&amp; decoded');
});

test('XMLTV times are read with their offset, not as local wall clock', () => {
  // Getting this wrong puts every kick-off out by an hour, which is worse
  // than having no listing at all.
  assert.equal(xc.xmltvTime('20261007180000 +0000'), Date.UTC(2026, 9, 7, 18, 0, 0) / 1000);
  assert.equal(xc.xmltvTime('20261007180000 +0100'), Date.UTC(2026, 9, 7, 17, 0, 0) / 1000);
  assert.equal(xc.xmltvTime('20261007180000 -0500'), Date.UTC(2026, 9, 7, 23, 0, 0) / 1000);
  assert.equal(xc.xmltvTime('nonsense'), 0);
});

test('"who is playing Derby tonight" finds the fixture AND the channel', () => {
  const hits = xc.findProgrammes('who is playing derby tonight', { service: 1 });
  assert.ok(hits.length, 'found something');
  assert.match(hits[0].title, /Derby County v Leeds United/);
  assert.equal(hits[0].channel, 'UK: Sky Sports Main Event',
    'the channel name is the answer — the epg id means nothing to a customer');
});

test('a programme with no channel in the lineup is never offered', async () => {
  db.prepare("DELETE FROM xc_channels WHERE epg_channel_id = 'skysports.main'").run();
  try {
    assert.equal(xc.findProgrammes('derby', { service: 1 }).length, 0,
      'naming a programme we cannot tell them how to watch is not an answer');
  } finally {
    await loadGuide();
  }
});

test('a question of nothing but filler matches nothing', () => {
  assert.equal(xc.findProgrammes('what is on tonight then', { service: 1 }).length, 0,
    'better to say we do not know than to return the first thing in the guide');
});

test('fixture questions are recognised where channel questions were not', () => {
  for (const q of [
    'who is playing derby tonight',
    "who's playing tonight",
    'what time is the arsenal game',
    'what time is kick off',
  ]) assert.equal(xc.looksLikeFixtureQuestion(q), true, q);
  for (const q of ['my app keeps buffering', 'how do i install on firestick']) {
    assert.equal(xc.looksLikeFixtureQuestion(q), false, q);
  }
});

test('grounding answers a fixture question with the channel and the time', async () => {
  const g = await xc.channelGrounding('who is playing derby tonight', { service: 1 });
  assert.match(g, /Derby County v Leeds United/);
  assert.match(g, /UK: Sky Sports Main Event/, 'and where to watch it');
  assert.match(g, /\d{2}:\d{2}/, 'and when');
});

test('a wrong password on the guide never leaks the URL or the password', async () => {
  setSetting('services.xcPass1', 'wrongpw');
  try {
    const r = await xc.refreshGuide(1);
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error, /rightpw|wrongpw|127\.0\.0\.1|xmltv/,
      'the credential rides in the query string, so no error may carry the URL');
  } finally {
    setSetting('services.xcPass1', 'rightpw');
  }
});

test('a failed download leaves the guide we already had', async () => {
  await loadGuide();
  const before = xc.programmeCount(1);
  const url = `http://127.0.0.1:${panel.address().port}`;
  setSetting('services.url1', 'http://127.0.0.1:1');
  try {
    const r = await xc.refreshGuide(1);
    assert.equal(r.ok, false);
    assert.equal(xc.programmeCount(1), before, 'a blip must not cost us the whole guide');
  } finally {
    setSetting('services.url1', url);
  }
});

test('the asked-for time ranks first but never excludes a match we hold', () => {
  // Someone asking at lunchtime who is playing "tonight" must not be told we
  // have no listing for a fixture we are holding, just because they picked
  // the wrong word for 5pm.
  const hits = xc.findProgrammes('who is playing derby tonight', { service: 1 });
  assert.ok(hits.some((h) => /Derby/.test(h.title)), 'found whatever the hour');
  // And a question with no time word still works.
  assert.ok(xc.findProgrammes('what channel is the derby game on', { service: 1 }).length);
});

test('"tonight" and "tomorrow" pick out different windows', () => {
  const [tonightFrom] = xc.timeWindow('who is playing tonight');
  const [tomorrowFrom] = xc.timeWindow('whats on tomorrow');
  assert.ok(tomorrowFrom > tonightFrom, 'tomorrow starts later than tonight');
  const [defFrom, defTo] = xc.timeWindow('what channel is the f1 on');
  assert.ok(defTo - defFrom >= 23 * 3600, 'no time word means roughly the next day');
});

// --- the VOD library ---------------------------------------------------------

test('the library is pulled and both films and series are kept', async () => {
  const r = await xc.refreshVod(1);
  assert.equal(r.ok, true);
  assert.equal(r.count, 4);
  assert.equal(db.prepare("SELECT kind FROM xc_vod WHERE name = 'Severance'").get().kind, 'series');
});

test('an empty library from the panel never wipes the one we have', async () => {
  const before = xc.vodCount(1);
  const keptM = vodStreams; const keptS = vodSeries;
  vodStreams = []; vodSeries = [];
  try {
    const r = await xc.refreshVod(1);
    assert.equal(r.ok, false);
    assert.equal(xc.vodCount(1), before, 'a panel blip must not make us claim we carry nothing');
  } finally {
    vodStreams = keptM; vodSeries = keptS;
    await xc.refreshVod(1);
  }
});

test('a title is matched through the decoration library names carry', () => {
  // "Oppenheimer 4K", "The Batman [2022] IMAX" — nobody asks for it that way.
  assert.match(xc.findVodTitle('Oppenheimer', { service: 1 })[0].name, /Oppenheimer/);
  assert.match(xc.findVodTitle('oppenheimer (2023)', { service: 1 })[0].name, /Oppenheimer/);
  assert.match(xc.findVodTitle('the batman', { service: 1 })[0].name, /Batman/);
  assert.match(xc.findVodTitle('Severance season 2', { service: 1 })[0].name, /Severance/);
});

test('a short title never matches by being a fragment of a longer one', () => {
  // "Up" is inside dozens of names. Sending someone hunting for a film we do
  // not carry is worse than taking a duplicate request.
  assert.equal(xc.findVodTitle('Up', { service: 1 })[0].exact, true, 'an exact short title still matches');
  assert.equal(xc.findVodTitle('man', { service: 1 }).length, 0, 'but a fragment does not');
  assert.equal(xc.findVodTitle('Batma', { service: 1 }).length, 0);
});

test('a title we do not carry is reported as missing, not as the nearest thing', () => {
  assert.equal(xc.findVodTitle('Dune Part Three', { service: 1 }).length, 0);
});

test('the libraries are per service and never answered from the wrong one', () => {
  assert.equal(xc.vodKnown(2), false, 'service 2 has no library cached');
  assert.equal(xc.findVodTitle('Oppenheimer', { service: 2 }).length, 0,
    'service 1 carrying it says nothing about service 2');
});

test('the guide downloads once a day, and the kept window always covers the gap', async () => {
  const { getSetting } = await import('../src/settings.js');
  // Tens of megabytes four times a day bought nothing: the listings it
  // carries do not change that often.
  assert.equal(Number(getSetting('services.xmltvRefreshHours')), 24);
  // The window has to be at least as wide as the interval between downloads,
  // or there are hours every day with no listings and the bot quietly stops
  // answering fixture questions until the next pull.
  assert.ok(Number(getSetting('services.epgWindowHours')) >= Number(getSetting('services.xmltvRefreshHours')),
    'a day between downloads needs at least a day of listings held');
});

test('an install still on the old 6-hour default is moved to 24', async () => {
  const { setSetting } = await import('../src/settings.js');
  const { migrate } = await import('../src/db/schema.js');
  // Asserted against the stored row rather than getSetting: settings are
  // cached in process and the migration writes SQL underneath it. That is
  // fine at boot — db.js runs migrate() at import, before anything can read a
  // setting — but not inside a test that has just warmed the cache.
  const stored = () => db.prepare("SELECT value FROM settings WHERE key = 'services.xmltvRefreshHours'").get()?.value;

  setSetting('services.xmltvRefreshHours', 6);
  db.pragma('user_version = 23');
  migrate(db);
  assert.equal(stored(), '24', 'the old shipped default moves');

  // A number someone chose deliberately is left alone.
  setSetting('services.xmltvRefreshHours', 3);
  db.pragma('user_version = 23');
  migrate(db);
  assert.equal(stored(), '3');
  setSetting('services.xmltvRefreshHours', 24);
});

test('a run the panel dated is held for a day; the end time does the expiring', async () => {
  const { setSetting, getSetting } = await import('../src/settings.js');
  assert.equal(Number(getSetting('services.epgCacheMinutes')), 1440, 'a day by default');
  clearEpg();
  calls = [];
  epgStop = Math.floor(Date.now() / 1000) + 4 * 3600; // still running in 4h
  try {
    await xc.shortEpg(101, { service: 1 });
    assert.equal(epgCalls(), 1);
    // Two hours later the match is still on, so there is nothing to refetch.
    db.prepare('UPDATE xc_epg SET fetched_at = fetched_at - ?').run(2 * 3600);
    await xc.shortEpg(101, { service: 1 });
    assert.equal(epgCalls(), 1, 'still the same programme — no reason to ask again');

    // Once it has finished, it goes, long before the day is up.
    db.prepare('UPDATE xc_epg SET last_end = ?').run(Math.floor(Date.now() / 1000) - 60);
    await xc.shortEpg(101, { service: 1 });
    assert.equal(epgCalls(), 2, 'a finished run is never quoted as what is on next');
  } finally {
    epgStop = 0;
  }
});

test('a run with NO end time is never held for a day, whatever the setting says', async () => {
  // Without an end time there is no way to tell a finished programme from a
  // current one, so the TTL is the only thing between a customer and "next
  // on Sky Sports: a match that ended yesterday".
  clearEpg();
  calls = [];
  epgStop = 0; // the panel sends no stop_timestamp
  await xc.shortEpg(101, { service: 1 });
  assert.equal(epgCalls(), 1);
  db.prepare('UPDATE xc_epg SET fetched_at = fetched_at - ?').run(45 * 60);
  await xc.shortEpg(101, { service: 1 });
  assert.equal(epgCalls(), 2, 'capped well short of the configured day');
});

test('an install still on the old 30-minute default is moved to a day', async () => {
  const { setSetting } = await import('../src/settings.js');
  const { migrate } = await import('../src/db/schema.js');
  const stored = () => db.prepare("SELECT value FROM settings WHERE key = 'services.epgCacheMinutes'").get()?.value;

  setSetting('services.epgCacheMinutes', 30);
  db.pragma('user_version = 24');
  migrate(db);
  assert.equal(stored(), '1440');

  setSetting('services.epgCacheMinutes', 90);
  db.pragma('user_version = 24');
  migrate(db);
  assert.equal(stored(), '90', 'a number someone chose is not overridden');
  setSetting('services.epgCacheMinutes', 1440);
});
