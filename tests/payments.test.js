import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-pay-'));

const { setSetting } = await import('../src/settings.js');
const pay = await import('../src/payments.js');

// Real-shaped addresses, not real wallets.
const LTC = 'LbTpcL1qLMoCDbcZ4oVVnzZDNnFC5Y8PLJ';
const LTC_BECH32 = 'ltc1qg9r4rhxv3qs8d7mz0u4nqgkkqcy6xjnx5s5pvt';
const BTC = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const BTC_BECH32 = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

test('an address that is not even the right shape is refused, never stored', () => {
  assert.equal(pay.addressLooksValid('ltc', LTC), true);
  assert.equal(pay.addressLooksValid('ltc', LTC_BECH32), true);
  assert.equal(pay.addressLooksValid('btc', BTC), true);
  assert.equal(pay.addressLooksValid('btc', BTC_BECH32), true);
  // The ways an address actually gets broken: a truncated paste, a word, a
  // wallet name instead of an address, the right coin's address in the
  // wrong field.
  assert.equal(pay.addressLooksValid('ltc', LTC.slice(0, 20)), false, 'truncated paste');
  assert.equal(pay.addressLooksValid('ltc', 'my exodus wallet'), false);
  assert.equal(pay.addressLooksValid('btc', LTC_BECH32), false, 'an LTC address in the BTC field');
  assert.equal(pay.addressLooksValid('ltc', BTC_BECH32), false, 'a BTC address in the LTC field');
  assert.equal(pay.addressLooksValid('ltc', ''), false);
});

test('a coin with no address set is never offered', () => {
  setSetting('payments.ltcAddress', '');
  setSetting('payments.btcAddress', '');
  assert.deepEqual(pay.acceptedCoins(), [], 'nothing configured, nothing claimed');
  assert.equal(pay.walletMessage('whats the wallet address'), null);

  setSetting('payments.ltcAddress', LTC);
  assert.deepEqual(pay.acceptedCoins().map((c) => c.code), ['LTC']);
  // Telling someone we take Bitcoin with nowhere to send it is worse than
  // not offering it.
  assert.doesNotMatch(pay.coinsSentence(), /Bitcoin/);

  setSetting('payments.btcAddress', BTC);
  assert.deepEqual(pay.acceptedCoins().map((c) => c.code), ['LTC', 'BTC']);
  assert.match(pay.coinsSentence(), /Litecoin \(LTC\) or Bitcoin \(BTC\)/);
});

test('the address goes out exactly as stored, on its own line', () => {
  setSetting('payments.ltcAddress', LTC);
  setSetting('payments.btcAddress', BTC);
  const msg = pay.walletMessage('whats the btc address');
  assert.ok(msg.split('\n').includes(BTC), 'copyable without picking up surrounding words');
  assert.doesNotMatch(msg, new RegExp(LTC), 'they asked for one coin, they get that coin');
  assert.match(msg, /cannot be reversed/i);
});

test('asking without naming a coin offers every coin we take', () => {
  const msg = pay.walletMessage('where do i send the payment');
  assert.ok(msg.includes(LTC) && msg.includes(BTC));
});

test('asking for a coin we do not take says so instead of offering the wrong one', () => {
  setSetting('payments.btcAddress', '');
  const msg = pay.walletMessage('can i pay in bitcoin');
  assert.match(msg, /don't take Bitcoin/i);
  assert.ok(msg.includes(LTC), 'and says what we do take');
  setSetting('payments.btcAddress', BTC);
});

test('a wallet request is told apart from a question about a wallet app', () => {
  for (const q of [
    'whats the wallet address',
    'where do i send the payment',
    'can i have the btc address',
    'what address do i send the litecoin to',
  ]) assert.equal(pay.looksLikeWalletRequest(q), true, q);

  for (const q of [
    'my exodus app keeps crashing',
    'how do i install the app',
    'the stream keeps buffering',
    'whats the email address for support',
  ]) assert.equal(pay.looksLikeWalletRequest(q), false, q);
});

test('no address-shaped text survives a model reply', () => {
  // The dangerous case is not the model quoting OUR address — it is the model
  // inventing one. An invented address looks exactly as plausible to the
  // person pasting it, and the money is simply gone.
  for (const addr of [LTC, LTC_BECH32, BTC, BTC_BECH32, 'LbTpcL1qLMoCDbcZ4oVVnzZDNnFC5Y8PLX']) {
    const out = pay.redactWalletAddresses(`Send it to ${addr} and we'll sort you out.`);
    assert.ok(!out.includes(addr), `address survived redaction: ${addr}`);
    assert.match(out, /ask me for the wallet address/i, 'and says how to get the real one');
  }
});

test('redaction leaves ordinary support text alone', () => {
  for (const text of [
    'Enter code 3793766 in the Downloader app and click Go.',
    'Open https://aftv.news/3775005 in your browser.',
    'Your username is THM4821 and the app is Smarters Player Lite.',
    'Restart the app, then clear the cache from Manage Installed Applications.',
  ]) assert.equal(pay.redactWalletAddresses(text), text, text);
});
