import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
let seenPasswords = [];
let calls = [];
let epgListings = null; // null = the panel's default single listing
let epgStop = 0; // panel-reported stop_timestamp, 0 = omit it

before(async () => {
  panel = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seenPasswords.push(u.searchParams.get('password'));
    calls.push(u.searchParams.get('action'));
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
  await xc.shortEpg(101, { service: 1 });
  db.prepare('UPDATE xc_epg SET fetched_at = fetched_at - ?').run(31 * 60);
  await xc.shortEpg(101, { service: 1 });
  assert.equal(epgCalls(), 2, 'a 30-minute cache is 30 minutes old at most');
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
