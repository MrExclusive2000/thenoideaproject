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

before(async () => {
  panel = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seenPasswords.push(u.searchParams.get('password'));
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
      return res.end(JSON.stringify({ epg_listings: [{
        title: Buffer.from('Formula 1: Qatar Grand Prix').toString('base64'),
        description: Buffer.from('Live coverage').toString('base64'),
        start: '2026-10-07 18:00:00', end: '2026-10-07 20:00:00',
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

test('channel questions are told apart from support questions', () => {
  for (const q of ['what channel is the f1 on', 'whats on sky sports main event', 'where can i watch the darts']) {
    assert.equal(xc.looksLikeChannelQuestion(q), true, q);
  }
  for (const q of ['my app keeps buffering', 'how do i install on firestick', 'whats the downloader code']) {
    assert.equal(xc.looksLikeChannelQuestion(q), false, q);
  }
});
