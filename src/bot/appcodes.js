import { getSetting } from '../settings.js';

// Downloader codes, answered from settings rather than by the model.
//
// Live, in a DM: "I need install codes" got the Sky Glass code out of a
// knowledge entry, and then five straight refusals —
//
//   "Purple"                      -> "I'm not totally sure on that one."
//   "I want purple code"          -> "Do you mean purple code in a different
//                                     context?"
//   "The purple app or THM App"   -> "I'm not sure which purple app..."
//   "The app which isn't Sky glass" -> "I'm not sure which app..."
//   "3675005 app?"                -> "I'm not sure what 3675005 refers to."
//
// The Purple code was in apps.purpleCode the whole time. It only reached a
// customer if retrieval happened to surface a knowledge entry carrying the
// {purple} placeholder, and for Purple there wasn't one — so the answer
// existed and nobody could get at it. The model cannot be the fallback
// either: a made-up install code is caught and suppressed by the guardrails,
// which is exactly why the replies came out as "I'm not sure".
//
// A code is a stored fact with one right value, like the wallet address, so
// it is sent by code or not at all.
const APPS = [
  { id: 'purple', setting: 'apps.purpleCode', label: 'Purple', re: /\bpurple\b/i },
  { id: 'skyglass', setting: 'apps.skyGlassCode', label: 'Sky Glass', re: /\bsky\s?-?\s?glass\b/i },
];

// Asking for a code at all. "Downloader" and "aftv" are how the code is used,
// so naming either is asking for one.
const WANTS_A_CODE =
  /\bcodes?\b|\bdownloader\b|\baftv(?:\.news)?\b|\binstall\s+(?:number|id)\b|\bwhat(?:'?s| is)\s+the\s+number\b/i;

// "Purple" on its own, right after we handed over a different code, means
// "the Purple one". Without this the customer has to re-ask a question they
// already asked, which is what happened five times in a row.
const BARE_APP = /^\s*(?:the\s+)?([\w\s-]{3,20}?)(?:\s+(?:app|one|code))?\s*\??\s*$/i;

export function configuredApps() {
  return APPS.map((a) => ({ ...a, code: String(getSetting(a.setting) || '').trim() }))
    .filter((a) => a.code);
}

// Returns { app } when they named one, { ambiguous: true } when they asked
// for a code without saying which, or null when this is not a code request.
// `recentlyGaveCode` lets a bare app name count on its own.
export function parseCodeRequest(text, { recentlyGaveCode = false } = {}) {
  const t = String(text || '');
  if (!t.trim() || t.length > 160) return null;
  const apps = configuredApps();
  if (!apps.length) return null;

  const named = apps.find((a) => a.re.test(t));
  const asksForCode = WANTS_A_CODE.test(t);

  if (named && (asksForCode || recentlyGaveCode || BARE_APP.test(t))) return { app: named };
  // A code question that names NO app ("need the install code for the
  // firestick downloader") is the generic install question, and the FAQ
  // answers it well — this must not hijack it. The picker is only offered
  // once we are already mid-conversation about codes.
  // "I need install codes", with two apps configured, is best answered by
  // asking which — but "need the install code for the firestick downloader"
  // names the generic installer and the FAQ answers that one properly, so
  // naming a device or the downloader itself keeps this out of the way.
  const NAMES_A_DEVICE = /\b(?:fire\s?stick|firestick|fire\s?tv|android|iphone|ipad|ios|smart\s?tv|samsung|lg|downloader|aftv)\b/i;
  if (asksForCode && !named && (recentlyGaveCode || !NAMES_A_DEVICE.test(t))) {
    if (apps.length === 1) return { app: apps[0] };
    return { ambiguous: true, apps };
  }
  // "3675005 app?" — they are guessing at a code. Tell them the real ones
  // rather than "I'm not sure what 3675005 refers to".
  if (recentlyGaveCode && /^\s*\d{5,9}\s*(?:app)?\s*\??\s*$/.test(t)) {
    return apps.length === 1 ? { app: apps[0] } : { ambiguous: true, apps };
  }
  return null;
}

export function codeMessage(app) {
  return `${app.label} — Downloader code: ${app.code}\n\n`
    + 'Open the Downloader app, type that number in and press Go. '
    + 'If it asks, allow installs from unknown sources, then open it and sign in with the details you were given.';
}

export function whichCodeMessage(apps) {
  return `Which one do you need?\n${apps.map((a) => `• ${a.label}`).join('\n')}\n\nJust say the name and I'll send the code.`;
}
