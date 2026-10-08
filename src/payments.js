import { getSetting } from './settings.js';

// SAFETY, and the reason this file exists at all: a crypto address is the one
// value in this whole system where a single wrong character costs the customer
// real money with no way to get it back. A language model that is 99% accurate
// at copying a 42-character string is a disaster, so no address ever goes into
// the prompt and no address ever comes out of the model — the bot sends them
// from here, verbatim, or not at all. redactWalletAddresses is the backstop.

export const COINS = {
  ltc: { code: 'LTC', name: 'Litecoin', key: 'payments.ltcAddress' },
  btc: { code: 'BTC', name: 'Bitcoin', key: 'payments.btcAddress' },
};

// Deliberately loose on length and strict on alphabet: the job is to catch a
// truncated paste or a wrong-coin address, not to re-implement base58check.
const SHAPES = {
  ltc: [/^[LM][a-km-zA-HJ-NP-Z1-9]{25,34}$/, /^ltc1[02-9ac-hj-np-z]{20,70}$/i, /^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/],
  btc: [/^[13][a-km-zA-HJ-NP-Z1-9]{24,34}$/, /^bc1[02-9ac-hj-np-z]{20,70}$/i],
};

export function addressLooksValid(coin, address) {
  const shapes = SHAPES[String(coin).toLowerCase()];
  const a = String(address || '').trim();
  if (!shapes || !a) return false;
  return shapes.some((re) => re.test(a));
}

export function walletAddress(coin) {
  const c = COINS[String(coin).toLowerCase()];
  if (!c) return '';
  return String(getSetting(c.key) || '').trim();
}

// Only coins with an address set are offered. Saying "we take Bitcoin" and
// then having nowhere to send it is worse than not offering it.
export function acceptedCoins() {
  return Object.entries(COINS)
    .map(([id, c]) => ({ id, ...c, address: walletAddress(id) }))
    .filter((c) => c.address);
}

export function coinsSentence() {
  const names = acceptedCoins().map((c) => `${c.name} (${c.code})`);
  if (!names.length) return 'crypto';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

// ---- the deterministic reply ------------------------------------------------

const ADDRESS_WORD = /\b(address|addy)\b/i;
// Phrasings that are a request to pay on their own, with no other context.
const WHERE_TO_SEND = /\bwhere\s+(do|should|shall|can)\s+i\s+send\b|\bwho\s+do\s+i\s+(pay|send\s+it\s+to)\b|\bhow\s+do\s+i\s+pay\s+(you|yous|ya)\b/i;

// How people actually ask, which is almost never with the word "address".
// Every one of these was going to the model or the off-topic brush-off while
// walletMessage() sat ready to answer it — including the case it already
// handles properly, "we don't take Monero, here's what we do take".
// A customer asking how to give you money is the last message that should
// ever get "I'm not totally sure on that one".
const HOW_TO_PAY =
  /\b(?:can|could|do|does|will|is it possible to)\s+(?:i|we|you|yous|ya)\b[^.?!\n]{0,24}\b(?:pay|paying|send|accept|take)\b/i;
const WHAT_ACCEPTED =
  /\bwhat\s+(?:coins?|crypto|currenc\w+|payments?|methods?)\b|\bwhich\s+(?:coins?|crypto|currenc\w+)\b|\bhow\s+(?:do|can|should)\s+(?:i|we)\s+pay\b|\bpayment\s+(?:options?|methods?|details?)\b|\bhow\s+(?:do|can)\s+(?:i|we)\s+(?:renew|subscribe|top\s?up)\b/i;
// What the address would be FOR. "address" alone could be an email address.
// Coins we do NOT take are listed deliberately: "do you take Monero?" is
// answered best by walletMessage, which says we do not and names what we do.
// Silence or a guess sends somebody off to buy the wrong thing.
const MONEY_WORD = /\b(wallet|pay|paying|payment|renew|renewal|crypto|litecoin|ltc|bitcoin|btc|coins?|funds|money|transfer|send|monero|xmr|ethereum|eth|usdt|tether|usdc|doge|dogecoin|solana|sol|cash|card|paypal|revolut|bank)\b/i;

export function looksLikeWalletRequest(text) {
  const s = String(text || '');
  if (s.length > 200) return false;
  if (WHERE_TO_SEND.test(s) || WHAT_ACCEPTED.test(s)) return true;
  // "Can I pay in Bitcoin?", "do you take BTC" — a coin or money word in a
  // can-I-pay shape.
  if (HOW_TO_PAY.test(s) && MONEY_WORD.test(s)) return true;
  // "my wallet app crashed" is a support question — it never asks for an
  // address. "whats the email address" is not about money.
  return ADDRESS_WORD.test(s) && MONEY_WORD.test(s);
}

// Which coin did they name, if any.
export function requestedCoin(text) {
  const s = String(text || '').toLowerCase();
  if (/\b(btc|bitcoin)\b/.test(s)) return 'btc';
  if (/\b(ltc|litecoin|lite\s?coin)\b/.test(s)) return 'ltc';
  return null;
}

// Things people ask to pay with that we do not take. Named so the answer can
// say so outright — "here are our addresses" in reply to "do you take PayPal?"
// reads as a yes, and somebody goes and buys the wrong thing.
const NOT_TAKEN = [
  [/\bmonero|xmr\b/i, 'Monero'], [/\beth(ereum)?\b/i, 'Ethereum'],
  [/\busdt|tether\b/i, 'USDT'], [/\busdc\b/i, 'USDC'],
  [/\bdoge(coin)?\b/i, 'Dogecoin'], [/\bsolana|\bsol\b/i, 'Solana'],
  [/\bpaypal\b/i, 'PayPal'], [/\brevolut\b/i, 'Revolut'],
  [/\bbank\s*transfer|\bbacs\b/i, 'bank transfer'],
  [/\bcash\b/i, 'cash'], [/\b(credit|debit)?\s*card\b/i, 'card'],
];

export function walletMessage(text = '') {
  const coins = acceptedCoins();
  if (!coins.length) return null;
  const wanted = requestedCoin(text);
  // Asked about something we do not take, and it is not one of ours.
  if (!wanted) {
    const refused = NOT_TAKEN.find(([re]) => re.test(text));
    if (refused) {
      const lines = [`We don't take ${refused[1]}, sorry — it's crypto only. Here's what we do take:`, ''];
      for (const c of coins) lines.push(`${c.name} (${c.code}) — send to this address only:`, c.address, '');
      lines.push(
        'Double-check the address before you send, and make sure you are sending the right coin to the right address — a transfer to the wrong address cannot be reversed.',
        "Send the exact amount the admin gives you, then post a screenshot of the confirmation here and we'll activate or renew you."
      );
      return lines.join('\n').trim();
    }
  }
  const show = wanted && coins.some((c) => c.id === wanted)
    ? coins.filter((c) => c.id === wanted)
    : coins;

  const lines = [];
  if (wanted && !show.some((c) => c.id === wanted)) {
    lines.push(`We don't take ${COINS[wanted].name} at the moment. Here's what we do take:`);
  }
  for (const c of show) {
    // One address per message block, on its own line, so it is tappable and
    // copyable in Telegram without picking up surrounding words.
    lines.push(`${c.name} (${c.code}) — send to this address only:`, c.address, '');
  }
  lines.push(
    'Double-check the address before you send, and make sure you are sending the right coin to the right address — a transfer to the wrong address cannot be reversed.',
    'Send the exact amount the admin gives you, then post a screenshot of the confirmation here and we\'ll activate or renew you.'
  );
  return lines.join('\n').trim();
}

// ---- the backstop -----------------------------------------------------------

// Anything address-shaped in model output is replaced, whether or not it
// matches a stored address. A hallucinated address is the dangerous case: it
// looks exactly as plausible as the real one and the money is simply gone.
const ADDRESS_SHAPED = /\b(?:(?:bc|ltc)1[02-9ac-hj-np-z]{20,70}|[13LM][a-km-zA-HJ-NP-Z1-9]{24,34})\b/gi;

export function redactWalletAddresses(text) {
  return String(text ?? '').replace(
    ADDRESS_SHAPED,
    'the wallet address (ask me for the wallet address and I\'ll send it)'
  );
}
