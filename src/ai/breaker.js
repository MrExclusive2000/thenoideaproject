// A dead AI endpoint used to cost ten seconds per call — the TCP connect
// timeout — and the bot calls it constantly: once to embed the question, once
// to answer it, and again to reword canned greetings. So a misconfigured or
// offline endpoint turned every message into a 20-second wait ending in "I
// couldn't answer that", which from the outside is indistinguishable from the
// bot being down.
//
// Once an endpoint has refused to connect a few times in a row, stop asking.
// Everything downstream already has a fallback — FAQ answers, saved canned
// text, keyword matching — and those are instant, so failing fast makes the
// bot *better* while the endpoint is broken, not just quicker to give up.

const OPEN_AFTER_FAILURES = 2;
const OPEN_FOR_MS = 60 * 1000;

const circuits = new Map(); // key -> { fails, openUntil, lastError }

// Only connection-level failures count. A model that is merely slow must never
// trip this: on a CPU node a generation timeout is normal, and treating it as
// "endpoint down" would disable the AI exactly when it is working as expected,
// just slowly.
export function isConnectionError(cause) {
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|WRONG_VERSION_NUMBER|SSL|TLS|fetch failed/i
    .test(String(cause || ''));
}

export function circuitOpen(key) {
  const c = circuits.get(key);
  if (!c?.openUntil) return false;
  if (Date.now() >= c.openUntil) {
    // Half-open: let the next call through to see whether it has come back.
    c.openUntil = 0;
    c.fails = 0;
    return false;
  }
  return true;
}

export function circuitError(key) {
  const c = circuits.get(key);
  const seconds = c?.openUntil ? Math.ceil((c.openUntil - Date.now()) / 1000) : 0;
  const err = new Error(
    `AI endpoint at ${key} is not responding (${c?.lastError || 'connection failed'}). ` +
    `Not retrying for ${seconds}s — answering from FAQs instead. Check the endpoint in AI settings.`
  );
  err.code = 'AI_DOWN';
  return err;
}

export function recordFailure(key, cause) {
  if (!isConnectionError(cause)) return false;
  const c = circuits.get(key) || { fails: 0, openUntil: 0, lastError: null };
  c.fails += 1;
  c.lastError = String(cause).slice(0, 120);
  if (c.fails >= OPEN_AFTER_FAILURES) c.openUntil = Date.now() + OPEN_FOR_MS;
  circuits.set(key, c);
  return Boolean(c.openUntil);
}

export function recordSuccess(key) {
  const c = circuits.get(key);
  if (c) circuits.set(key, { fails: 0, openUntil: 0, lastError: null });
}

export function breakerStatus(key) {
  const c = circuits.get(key);
  if (!c) return { down: false, fails: 0 };
  return {
    down: Boolean(c.openUntil && Date.now() < c.openUntil),
    fails: c.fails,
    lastError: c.lastError,
    retryInSeconds: c.openUntil ? Math.max(0, Math.ceil((c.openUntil - Date.now()) / 1000)) : 0,
  };
}

// Test helper.
export function _resetCircuits() {
  circuits.clear();
}
