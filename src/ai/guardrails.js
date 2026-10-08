// Strict-topic enforcement for LLM output. The system prompt instructs the
// model to reply with the single word OFFTOPIC for anything not covered by
// the admin's knowledge; this module is the code-side backstop.

export const OFFTOPIC_SENTINEL = 'OFFTOPIC';

const PREAMBLE_PATTERNS = [
  /^(sure|certainly|of course|okay|ok|alright|great question|good question)[,!.:]\s*/i,
  /^(as an ai( language model)?|as a support (bot|assistant))[^.]*\.\s*/i,
  /^(here('|’)s (what|the answer)|according to (the|my) (knowledge|information|faq)[^.:]*)[.:]\s*/i,
];

export function cleanReply(raw, { maxChars = 1500 } = {}) {
  if (!raw) return null;
  let text = String(raw);

  // Reasoning models sometimes leak <think> blocks — never send those.
  text = text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');

  // Replies go out as plain text (no parse_mode) — models ignore the
  // "no markdown" instruction often enough that literal **asterisks** would
  // reach the chat, so strip common markdown instead of trusting them.
  text = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1') // single-asterisk *italics* leak too
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*/g, ''); // unpaired ** left by a mid-bold truncation

  text = text.replace(/^["'\s]+|["'\s]+$/g, '').trim();

  if (!text) return null;
  if (text.toUpperCase().includes(OFFTOPIC_SENTINEL)) return null;

  for (const pattern of PREAMBLE_PATTERNS) text = text.replace(pattern, '');
  text = text.trim();
  if (!text) return null;

  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    text = cut.slice(0, Math.max(cut.lastIndexOf('. ') + 1, cut.lastIndexOf('\n'), maxChars - 200)).trim();
  }
  return text || null;
}

// Models decorate their sign-offs with emoji AFTER the punctuation — "What
// about you? 🎭" — which defeats a plain endsWith('?'). Strip trailing
// emoji/symbol decorations before asking "does this end with a question?".
const TRAILING_DECOR = /(?:\s|\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}]|️|‍)+$/u;

export function endsWithQuestion(text) {
  return String(text || '').replace(TRAILING_DECOR, '').endsWith('?');
}

// The rules allow a question mark only when the ENTIRE reply is one short
// clarifying question. Models still love closing a full answer with "Do you
// have any other questions?" — a dead end for a bot that can't follow up,
// and it would be mistaken for a real clarifying question by the
// clarify-then-combine flow. Strip trailing question sentences whenever real
// content precedes them; a pure clarifying question is left untouched.
export function stripDeadEndQuestion(reply) {
  let out = String(reply || '').trimEnd();
  for (let i = 0; i < 12; i++) {
    const bare = out.replace(TRAILING_DECOR, '');
    if (bare.endsWith('?')) {
      out = bare; // the decorations go with the question they decorate
      const lineIdx = out.lastIndexOf('\n');
      const head = lineIdx === -1 ? '' : out.slice(0, lineIdx + 1);
      const lastLine = out.slice(lineIdx + 1);
      // A bullet/numbered question ("- Which film did you watch?") goes as a
      // whole line — sentence-cutting one would leave a dangling "3." stub.
      const isBullet = /^\s*(?:[-•*]|\d+[.)])\s/.test(lastLine);
      // Otherwise keep any complete sentences on the line before the question.
      const m = isBullet ? null : lastLine.match(/^([\s\S]*[.!:)])\s*[^.!?\n]*\?$/);
      const candidate = (head + (m ? m[1] : '')).trimEnd();
      // Nothing of substance left → the reply IS the clarifying question.
      if (candidate.length < 25) return out;
      out = candidate;
      continue;
    }
    // Stripping a question list can leave its intro dangling — "here are a
    // few things we can check:" — cut that trailing colon sentence too and
    // keep going (it may expose another question above it).
    if (i > 0 && out.endsWith(':')) {
      const lineIdx = out.lastIndexOf('\n');
      const lastLine = out.slice(lineIdx + 1);
      const m = lastLine.match(/^([\s\S]*[.!?)])\s*[^.!?\n]*:$/);
      const candidate = ((lineIdx === -1 ? '' : out.slice(0, lineIdx + 1)) + (m ? m[1] : '')).trimEnd();
      if (candidate.length < 25) return out;
      out = candidate;
      continue;
    }
    break;
  }
  return out;
}

// Models also love closing with "feel free to ask!" / "let me know if you
// need anything else" — invitations to keep chatting that dodge the
// question-mark rule above by ending in "!" or ".". The bot can't follow up
// on its own and must not fish for conversation, so trailing invitation
// sentences are cut whenever real content precedes them.
// Concrete invite phrases only — a generic "if you need/have..." test would
// also kill legit trailing advice like "If you have a VPN, turn it off."
// Only DEAD ENDS are stripped: lines that promise a follow-up the bot cannot
// make, because it gets no second message. A warm or promotional sign-off is
// not a dead end and is left alone on purpose — the bot is the front door of
// the service and sounding like it wants the custom is the point.
const INVITE_RE = /\b(feel free|let me know|just ask|ask away|don'?t hesitate|happy to (help|chat|assist)|any (other |more )?questions|i'?m (always )?here (to|if|for)|here to help|reach out|hit me up|shout if|(what|how) about you)\b/i;

export function stripInvitationTail(reply) {
  let out = String(reply || '').trimEnd();
  for (let i = 0; i < 3; i++) {
    // Last sentence: everything after the final sentence boundary (ignoring
    // the terminator the reply itself ends with).
    const body = out.replace(/[.!?]+$/, '');
    const idx = Math.max(body.lastIndexOf('. '), body.lastIndexOf('! '), body.lastIndexOf('? '), body.lastIndexOf('\n'));
    const last = out.slice(idx + 1).trim();
    if (!INVITE_RE.test(last)) return out;
    const candidate = out.slice(0, idx + 1).trimEnd();
    if (candidate.length < 25) return out; // nothing of substance would remain
    out = candidate;
  }
  return out;
}

// The model hit its token cap mid-sentence ("Internet Speed Issues\n1. Use") —
// cut back to the last complete sentence, then drop any heading or bullet
// stub left dangling above the cut.
export function trimTruncatedTail(reply) {
  let out = String(reply || '').trimEnd();
  for (let i = 0; i < 5; i++) {
    const lineIdx = out.lastIndexOf('\n');
    const lastLine = out.slice(lineIdx + 1).trim();
    // A complete line ends in real punctuation — and "1." alone is a list
    // enumerator stub, not a sentence.
    if (lastLine && /[.!?:)\]…]$/.test(lastLine) && !/^\d+[.)]$/.test(lastLine)) break;
    if (lineIdx === -1) {
      // Single line: cut at the last true sentence end ("1. Use" is not one).
      let cut = -1;
      for (const m of out.matchAll(/[.!?](?=\s)/g)) {
        if (!/\d/.test(out[m.index - 1] || '')) cut = m.index;
      }
      return cut >= 12 ? out.slice(0, cut + 1) : out;
    }
    const candidate = out.slice(0, lineIdx).trimEnd();
    if (candidate.length < 25) return out;
    out = candidate;
  }
  return out;
}

// The model must never reveal its instructions, even when a group member asks
// it to. Suppress any reply that quotes a meaningful chunk of the prompt.
export function leaksSystemPrompt(reply, systemPrompt) {
  if (!reply || !systemPrompt) return false;
  const normalizedReply = reply.toLowerCase().replace(/\s+/g, ' ');
  const normalizedPrompt = systemPrompt.toLowerCase().replace(/\s+/g, ' ');
  const window = 60;
  for (let i = 0; i + window <= normalizedPrompt.length; i += 30) {
    if (normalizedReply.includes(normalizedPrompt.slice(i, i + window))) return true;
  }
  return false;
}

// A reply that reads like the brief rather than the answer. A small model
// handed "say we do not have that listing and point them at the guide" will
// sometimes repeat it at the customer instead of doing it — which happened:
// "We do not have it listed. Say we do not have that listing and point them
// at the guide in the app."
//
// Verbatim matching misses this because the model paraphrases, and because
// some of the brief lives in other system messages (the channel facts block)
// that were never compared against. What gives it away is the shape: a reply
// to a customer never instructs someone about what to tell them.
const INSTRUCTION_ECHO = /\b(?:say|tell|inform|remind|point|direct|refer|advise)\s+(?:them|him|her|the\s+(?:user|customer|member))\b|\b(?:say|reply|respond|answer)\s+(?:with\s+)?(?:exactly|only|plainly|just)\b|\bdo\s+not\s+(?:mention|invent|guess|offer|state)\b|\buse\s+(?:those|these)\s+exact\b|\brather\s+than\s+(?:offering|guessing)\s+the\s+(?:nearest|closest)\b/i;

export function echoesInstructions(reply) {
  return INSTRUCTION_ECHO.test(String(reply || ''));
}

// A handoff to a human, in any of the shapes a model writes one.
// Things you can actually DO, and things you can do them to. Text naming
// none of these is reassurance, not troubleshooting.
const STEP_THING = /\b(app|apps|cache|caches|router|wifi|ethernet|vpn|stream|streams|link|links|server|servers|channel|channels|login|password|username|device|firestick|downloader|box|tv|guide|epg|epgs|subtitle|audio|quality|connection|data|dns|speed|playlist|account|purple|smarters|sky\s*glass|xc)\b/i;
const STEP_ACTION = /\b(restart|reboot|reinstall|install|clear|clearing|switch|switching|change|changing|try|open|enter|turn|disable|enable|unplug|update|updating|log\s+(?:in|out)|sign\s+(?:in|out)|force\s+stop|refresh|select|pick|check|use)\b/i;

const HANDOFF_RE = /\b(?:message|contact|dm|speak\s+to|talk\s+to|reach\s+out\s+to|get\s+in\s+touch\s+with|ask)\s+(?:@\w+|an?\s+admin|the\s+admin|the\s+team|support|customer\s+service)\b|\b(?:the\s+)?admin\s+(?:will|can|should)\b|\bfurther\s+assistance\b/i;

// The first answer to a problem must not end by sending them to a human. The
// system adds its own line immediately after — "still happening? reply here
// and I'll dig up the next things to try" — so a handoff above it contradicts
// the very next sentence, and the customer gets one thin fix and a brush
// toward the admin instead of the playbook they were owed.
//
// Only the trailing sentences go, and only while something of substance
// remains: when the handoff IS the answer (a renewal, a payment, an expired
// account) there is nothing else in the reply and it stays untouched.
export function stripPrematureHandoff(reply) {
  let out = String(reply || '').trimEnd();
  for (let i = 0; i < 3; i++) {
    const body = out.replace(/[.!?]+$/, '');
    const idx = Math.max(body.lastIndexOf('. '), body.lastIndexOf('! '), body.lastIndexOf('? '), body.lastIndexOf('\n'));
    const last = out.slice(idx + 1).trim();
    if (!HANDOFF_RE.test(last)) break;
    const candidate = out.slice(0, idx + 1).trimEnd();
    // Only cut it when what remains actually tells them something to DO.
    // Otherwise the handoff was the answer — a renewal, a payment, "I can't
    // help with that, message an admin" — and removing it leaves the customer
    // with nothing at all.
    if (!STEP_THING.test(candidate) || !STEP_ACTION.test(candidate)) break;
    out = candidate;
  }
  return out
    // The lead-in that pointed at the handoff is now pointing at nothing.
    .replace(/\s*(?:still\s+no\s+luck\??|if\s+that\s+fails\??|otherwise\??)\s*$/i, '')
    // And the step number it was written as. Cutting "4. Message the admin"
    // out of a numbered list leaves a bare "4." sitting on the end, which
    // looks like the bot broke mid-sentence.
    .replace(/\n\s*(?:\d{1,2}[.)]|[-•*])\s*$/, '')
    .trimEnd();
}

// Things you can actually DO, and things you can do them to. A round of
// troubleshooting that names none of these is not a round of troubleshooting.

// A follow-up round that tells the customer nothing they can act on. They
// have just said the first fixes did not work; replying "give it a shot and
// let me know" repeats the thing they already tried and loops them, which is
// worse than admitting it needs a person.
export function offersNoNewHelp(reply) {
  const text = String(reply || '').trim();
  if (!text) return true;
  // Reassurance with nothing attached. Short AND vague is the giveaway —
  // a genuine "try the backup app with the same login" is neither.
  if (!STEP_THING.test(text) || !STEP_ACTION.test(text)) return true;
  return false;
}

// Has the bot already said this? Asked "are you being dumb?", it replied with
// the same six steps it had just given — which is the one thing the service
// was announced to customers as not doing.
//
// Compared on content words only, so rewording the same advice still counts
// as repeating it: a model told to try again will reorder and re-pad the
// same list rather than find anything new.
const CONTENT_STOP = new Set([
  'the', 'and', 'you', 'your', 'for', 'with', 'this', 'that', 'then', 'from', 'are', 'can',
  'try', 'any', 'all', 'into', 'out', 'back', 'about', 'they', 'their', 'have', 'has',
  'will', 'would', 'should', 'please', 'issue', 'still', 'more', 'other', 'step', 'steps',
]);

const contentWords = (text) => new Set(
  (String(text || '').toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !CONTENT_STOP.has(w))
);

export function repeatsPreviousAnswer(reply, previous, { threshold = 0.65 } = {}) {
  const now = contentWords(reply);
  const before = contentWords(previous);
  if (now.size < 4 || before.size < 4) return false;
  let shared = 0;
  for (const w of now) if (before.has(w)) shared++;
  // Against the SMALLER set, so padding a repeat with filler does not hide it.
  return shared / Math.min(now.size, before.size) >= threshold;
}

export function containsBannedWord(text, bannedWords) {
  if (!text || !bannedWords?.length) return false;
  const lower = text.toLowerCase();
  return bannedWords.some((w) => w && lower.includes(String(w).toLowerCase()));
}

// A support bot must NEVER ask a customer for their password. Asked "I want
// to invite my friend", the model replied "Please share your username and
// password so I can create the link", the customer sent both, and it handed
// back a link with the password in the query string. Three different
// disasters, and the first one is the one that generalises: a bot that asks
// for passwords teaches customers that handing a password to whoever asks is
// how this service works, and the next person to ask will not be the bot.
//
// So this is a hard suppress, not a strip. There is no version of a reply
// asking for a password that is worth sending.
//
// Asking for a USERNAME alone is fine and the bot does it legitimately (it is
// how a customer's service is identified), so the word "password" and friends
// are what this keys on. Telling someone to TYPE their password into the app
// is also fine — that is device-local, and the giveaway for the dangerous
// version is a verb that means "send it to me".
const CREDENTIAL_REQUEST =
  /\b(?:send|share|give|provide|tell|post|paste|dm|forward|reply(?:ing)? with|let me know|confirm|need|needs|require|requires|what(?:'?s| is)|may i have|can i (?:have|get))\b[^.?!\n]{0,60}\b(?:password|passwd|pwd|credentials|log-?in details|login details|account details|sign-?in details|login info|account info)\b/i;

export function asksForCredentials(reply) {
  return CREDENTIAL_REQUEST.test(String(reply || ''));
}

// Any URL carrying credentials in its query string, whoever wrote it. The
// model invented "…/invite?username=X&password=Y"; a customer pasting that
// anywhere has published their login. Belt to the suppression above, and it
// also covers canned and FAQ text an admin might paste in by accident.
const CREDENTIAL_URL = /\bhttps?:\/\/\S*[?&](?:pass(?:word|wd)?|pwd|pw|user(?:name)?|usr|token|auth|key)=\S*/gi;

export function redactCredentialUrls(text) {
  return String(text ?? '').replace(
    CREDENTIAL_URL,
    '[link removed — it had login details in it, which must never be shared]'
  );
}

// A hostname the model made up. "exclusiveexclusive.com" does not exist; a
// customer who clicks it gets nothing, and anyone can register it tomorrow
// and start collecting whatever lands there. Same shape as the invented-code
// and invented-brand checks: if the host is not in the knowledge or the
// conversation, the model did not get it from us.
export function inventsLink(reply, known) {
  const hosts = String(reply || '').match(/\bhttps?:\/\/([^\s/?#)"']+)/gi) || [];
  if (!hosts.length) return false;
  const haystack = String(known || '').toLowerCase();
  return hosts.some((raw) => {
    const host = raw.replace(/^https?:\/\//i, '').split(':')[0].toLowerCase();
    // t.me links are Telegram's own and are created by the bot, not written
    // by the model — but a model-written one is still an invention.
    return !haystack.includes(host);
  });
}

// A result the model made up. The sports block is handed over as fact with an
// instruction to use nothing else, but an instruction is not a control: the
// checkable claims are scorelines ("2-1") and positions ("P3"), and a customer
// who repeats an invented one in the group looks daft because of us.
//
// Only the claims that can be checked are checked. A wrong adjective is a
// wrong adjective; a wrong scoreline is a lie with a number in it.
export function invensSportsResult(reply, block) {
  if (!block) return false;
  const text = String(reply || '');
  const facts = String(block);
  const flat = facts.replace(/\s+/g, ' ');

  for (const score of text.match(/\b\d{1,2}\s?[-–]\s?\d{1,2}\b/g) || []) {
    const [h, a] = score.split(/[-–]/).map((n) => n.trim());
    // Written as "2-1" in the block; allow spacing differences either side.
    if (!new RegExp(`\\b${h}\\s?[-–]\\s?${a}\\b`).test(flat)) return true;
  }
  for (const pos of text.match(/\bP(\d{1,2})\b/g) || []) {
    if (!new RegExp(`\\b${pos}\\b`, 'i').test(flat)) return true;
  }
  return false;
}
