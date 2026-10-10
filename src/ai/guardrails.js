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
const STEP_THING = /\b(app|apps|cache|caches|router|wifi|wi-?fi|ethernet|vpn|stream|streams|link|links|server|servers|channel|channels|login|password|username|device|firestick|downloader|box|tv|guide|epg|epgs|subtitle|audio|quality|connection|data|dns|speed|playlist|account|purple|smarters|sky\s*glass|xc|plug|socket|mains|power|remote|settings|network|band|5\s?ghz|2\.4\s?ghz|firmware|storage|space|player|source|sources|port|modem|hotspot|signal|hdmi|cable|version|build|update|updates|recents|background)\b/i;
// The verb list was 24 words long and it decided whether a whole round of
// troubleshooting reached the customer. "Close the app fully and reopen it,
// then power-cycle the box at the plug" contains none of restart, reboot,
// clear, switch, try, open (\bopen\b does not fire inside "reopen")… so the
// second round was binned as "no new help" and the case escalated. The panel
// offers up to four rounds and the bot was giving one, whatever was set —
// which is the difference between a bot that keeps digging and one that
// gives up the moment you say it is still broken.
const STEP_ACTION = /\b(restart|restarting|reboot|rebooting|reinstall|reinstalling|install|installing|uninstall|clear|clearing|switch|switching|change|changing|try|open|opening|reopen|re-open|close|closing|shut|enter|turn|disable|enable|unplug|replug|plug|update|updating|upgrade|log\s+(?:in|out)|sign\s+(?:in|out)|force\s+stop|force-?close|refresh|select|pick|check|use|power[\s-]?cycl\w*|remove|delete|set|swap|move|connect|disconnect|hardwire|press|hold|long[\s-]?press|tap|click|reset|forget|rescan|reload|sideload|allow|point|lower|reduce|increase|toggle|wait|leave|run|add|type|retype|copy|paste|download|untick|tick|uncheck|scroll|factory\s+reset|pause|skip)\b/i;

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

// Advice that cannot possibly fix an invalid login, stripped sentence by
// sentence. The prompt tells the model this; a prompt is not a control, and
// the live reply to "Sky glass is saying invalid login" was "try a different
// link or stream for the channel, or use the backup app (XC or Smarters)
// with the same login details."
//
// The backup app takes the SAME details and refuses them the same way. So
// does a different stream, a different server and a reinstall: none of them
// touches the thing that is actually wrong. The customer spends twenty
// minutes proving it, comes back no better off, and the real cause — a
// mistyped character or an expired line — is still sitting there unlooked at.
const WRONG_FOR_LOGIN =
  /\b(?:different|another|alternative|other)\s+(?:link|stream|source|server|line)\b|\bswitch\w*\s+(?:link|stream|server|source)\b|\bbackup app\b|\b(?:try|use|open|download|install)\b[^.!?\n]{0,30}\b(?:smarters|xc(?:iptv)?|tivimate|ibo ?player|flix ?iptv)\b|\bclear\w*\s+(?:the\s+)?cache\b|\breinstall\w*\b|\b(?:restart|reboot|power ?cycle)\w*\s+(?:the\s+)?(?:app|device|box|stick|firestick|router)\b/i;

// What survives has to still tell them something to do, or stripping it
// leaves a reply that says nothing — worse than the wrong advice, because at
// least that looked like help.
const LOGIN_FIX =
  /\b(?:username|user name|password|details|credentials|capital|caps|space|spaces|type|typed|typing|re-?enter|enter|copy|paste|exactly|character|expired|expiry|renew\w*|run out|ran out|admin|team|device|devices|connection|connections)\b/i;

export function stripWrongLoginAdvice(reply) {
  const text = String(reply || '').trim();
  if (!text) return text;
  // Split on sentence ends and newlines, keeping the pieces whole.
  const parts = text.split(/(?<=[.!?])\s+|\n+/).map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p) => !WRONG_FOR_LOGIN.test(p));
  if (kept.length === parts.length) return text;
  const out = kept.join(' ').replace(/\s{2,}/g, ' ').trim();
  // Nothing actionable left: hand the whole thing back as empty so the caller
  // falls through to its own "I'm not sure, here is a human" path rather than
  // sending a fragment.
  return LOGIN_FIX.test(out) ? out : '';
}

// Advice the customer has already told us they tried, cut sentence by
// sentence. "I've already uninstalled and reinstalled it twice" was answered
// two messages later with "uninstall the app and reinstall it": the prompt
// asks the model not to, and asking was the only thing standing against it.
//
// `offers` is the caller's test for "does this sentence suggest fix X" — the
// vocabulary lives with the rest of the fix vocabulary, not here.
export function stripClaimedFixes(reply, tried, offers) {
  const text = String(reply || '').trim();
  if (!text || !tried?.length) return text;
  const parts = text.split(/(?<=[.!?])\s+|\n+/).map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p) => !offers(p, tried));
  if (kept.length === parts.length) return text;
  const out = kept.join(' ').replace(/\s{2,}/g, ' ').trim();
  // Everything it had to say was something they had already done. That is
  // not a reply — it is the moment to stop guessing and fetch a person, and
  // returning empty is how the caller is told so.
  return offersNoNewHelp(out) ? '' : out;
}

// Wired-ethernet advice given to a Fire TV Stick, which has no ethernet
// port. The clause is cut rather than the whole sentence, because the other
// half of it ("switch to the 5GHz band") is good advice that the customer
// should still get — and a short correction follows, since "can I plug it
// in?" is a question they ask anyway.
const ETHERNET_CLAUSE =
  /\s*(?:,|;|—|–|\.|\bor\b|\band\b|\bthen\b)?\s*(?:you\s+(?:can|could|should)\s+)?(?:try\s+|use\s+|run\s+|plug\s+in\s+|connect\s+(?:it\s+)?(?:with|via|using|to)\s+|switch\s+to\s+|go\s+)?(?:a\s+|an\s+|the\s+)?(?:wired\s+)?(?:ethernet|hard-?wired?|hard\s?wire|lan)\s*(?:cable|connection|port|adapter)?\s*(?:to\s+(?:it|the\s+\w+)|into\s+(?:it|the\s+\w+)|instead|if\s+you\s+can)?/gi;

const MENTIONS_ETHERNET = /\b(?:ethernet|hard-?wired?|hard\s?wire|lan\s+cable)\b/i;

export const FIRESTICK_ETHERNET_NOTE =
  "(A Firestick has no ethernet port, by the way — wired only works with Amazon's Ethernet Adapter, which plugs into the power socket on the stick.)";

export function fixEthernetForStick(reply) {
  const text = String(reply || '').trim();
  if (!text || !MENTIONS_ETHERNET.test(text)) return text;
  const parts = text.split(/(?<=[.!?])\s+|\n+/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (!MENTIONS_ETHERNET.test(part)) { out.push(part); continue; }
    // Whatever is left has to still be a sentence worth sending. "Or run an
    // ethernet cable to it." reduces to nothing, and a stray fragment is
    // worse than a missing line — as is the comma the cut clause leaves
    // behind ("switch to the 5GHz band if your router has one,.").
    const cleaned = part
      .replace(ETHERNET_CLAUSE, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,;!?])/g, '$1')
      .replace(/[,;]+(?=\s*(?:[.!?]|$))/g, '')
      .replace(/^[,;—–\s]+/, '')
      .trim()
      .replace(/[,;—–]+$/, '')
      .trim();
    if (cleaned.length >= 12 && !MENTIONS_ETHERNET.test(cleaned)) {
      out.push(/[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`);
    }
  }
  const body = out.join(' ').replace(/\s{2,}/g, ' ').trim();
  if (!body) return '';
  return `${body}\n\n${FIRESTICK_ETHERNET_NOTE}`;
}

// "To find the correct channel for Boxing on Saturday, you can ask me
// directly: 'What channel is Boxing on this Saturday?' I'll look up the
// channel list and TV guide to give you the exact channel."
//
// They had just asked that, in those words. They asked it again. The bot
// replied "To find the exact channel for Boxing on Saturday, I need to know
// the specific day or time you're interested in." They had said Saturday.
// Then the same loop for football, and after "I did just ask you that" the
// bot gave up and messaged the admin.
//
// This is the model deferring its own job: promising a lookup instead of
// doing one, and routing the customer back to the start. There is no reply
// where it is right — the customer is already talking to the bot, so there
// is no "directly" to ask it, and nothing happens later. Either the answer
// is in this message or the bot has to say it has not got it.
//
// Both halves are required, which is what keeps a genuine clarifying
// question out of it: "tell me which app and I'll send the code" asks for
// something the bot does not have. "Ask me X and I'll look X up" asks for
// something it was just given.
const ASK_ME = /\b(?:ask|asking)\s+(?:me|the\s+bot)\b|\bsend\s+me\s+(?:the\s+)?(?:same\s+)?(?:question|message)\s+again\b|\bre-?ask\b/i;
const WILL_LOOK_IT_UP =
  /\bI(?:'|’)?(?:ll|\s+will|\s+can|\s+could|\s+shall)\s+(?:then\s+)?(?:look|check|find|search|pull|fetch|get|provide|give|tell|show|list)\b|\bI(?:'|’)?m\s+able\s+to\s+(?:look|check|find)\b/i;

export function promisesALookup(reply) {
  const text = String(reply || '');
  if (!text.trim()) return false;
  return ASK_ME.test(text) && WILL_LOOK_IT_UP.test(text);
}

// "Bot can you send iOS guide" →
//
//   "To install the app on an iOS device, open https://aftv.news/3793766 in
//    your browser. This link works for the Sky Glass app. Allow installs
//    from unknown sources if your device asks. Install the app, open it,
//    and log in with your service details."
//
// Every sentence of that is impossible on an iPhone. aftv.news serves an
// Android APK, there is no Downloader app on iOS, and "allow installs from
// unknown sources" is a setting Apple does not have. The customer is sent
// to a dead end by a reply that sounds completely confident.
//
// The correct answer was already in the prompt: the iOS entry scores 1.0
// for "how do I install on my iphone" and Smarters Player Lite was sitting
// in the KNOWLEDGE block the model was handed. It reached past it for the
// Android instructions that were in there too. That is what a guardrail is
// for — the prompt was right and the model was wrong anyway.
//
// Suppressed whole rather than trimmed. Cutting the offending sentences
// leaves "This link works for the Sky Glass app" with no link above it, and
// a reply built on the wrong idea of the device does not have a good half.
// Suppression hands it to the stand-in, which sends the iOS entry verbatim
// — the complete, correct answer, App Store link and all.
const SIDELOAD =
  /\baftv\.news\b|\bdownloader\b|\bapk\b|\bunknown\s+sources\b|\bside-?load\w*\b|\bdeveloper\s+options\b|\bthird-?party\s+sources\b|\bdownload(?:er)?\s+code\b/i;

export function offersSideloadToApple(reply) {
  return SIDELOAD.test(String(reply || ''));
}

// The model telling a customer whether we carry a title.
//
// Live, one message after the system had correctly said "Don't Look Back in
// Anger (2026) isn't in there at the moment — I've checked":
//
//   "Don't look back in anger VOD"
//   → "The F1 race 'Don't Look Back in Anger' is in the VOD section. You
//      can check it there."
//
// Wrong twice over: it is not in the library, and it is not an F1 race —
// that came from the F1 conversation three messages earlier. The customer
// is sent hunting through the app for something we do not have, on the word
// of a bot that had just told them the opposite.
//
// The prompt already forbids this in as many words ("Never say a film or
// series IS available, IS in the VOD section, or is NOT there"). It is a
// rule the system can enforce instead of asking: availability is checked
// against the real library by code, and the model is never the one to
// answer it. A reply that does is dropped.
//
// Narrow on purpose. "New titles land in the VOD section" is a true,
// useful sentence about how requests work and says nothing about a
// particular title, so it has to survive.
const CLAIMS_VOD = new RegExp(
  '\\b(?:is|are|isn(?:\'|’)?t|aren(?:\'|’)?t|is\\s+not|was|will\\s+be)\\s+(?:already\\s+|now\\s+|currently\\s+)?'
  + '(?:in|on|available\\s+(?:in|on))\\s+(?:the\\s+|our\\s+)?(?:vod|movies?|series|library|catalogue|catalog)\\b'
  + '|\\b(?:you\\s+can\\s+)?(?:find|watch|check|see)\\s+(?:it|that|this|them)\\s+(?:in|on|under)\\s+(?:the\\s+|our\\s+)?(?:vod|movies?|series|library)\\b'
  + '|\\bit(?:\'|’)?s\\s+(?:in|on)\\s+(?:the\\s+|our\\s+)?(?:vod|movies?|series|library)\\b'
  + '|\\bwe\\s+(?:have|carry|do\\s+have|don(?:\'|’)?t\\s+have|do\\s+not\\s+have)\\s+(?:it|that|this)\\b',
  'i'
);

export function claimsVodAvailability(reply) {
  return CLAIMS_VOD.test(String(reply || ''));
}

// Has a "rewrite this line" come back about something else entirely?
//
// rephraseCanned checks a lot — commands, @handles, placeholders, length,
// banned words, credentials, invented links — and not whether the rewrite
// is still about the same subject. A reply of roughly the right length that
// shares nothing with the original passes every one of those gates, and the
// saved text is the one category of reply the admin fully controls: the
// buffering playbook, the payment steps, the escalation line. Replacing one
// of those with something the model made up is the worst trade in the
// system, and on a small CPU-hosted model a drifting rewrite is not an
// exotic failure.
//
// Only applied to substantial lines. A greeting rewritten from "Hey, what
// can I sort for you?" to "Alright mate — what's up?" shares no content
// words at all and is exactly what was asked for; a seven-step playbook
// that shares none has gone somewhere else.
export function driftsFromOriginal(original, rewrite, { minWords = 12, keep = 0.25 } = {}) {
  const before = contentWords(original);
  if (before.size < minWords) return false;
  const after = contentWords(rewrite);
  if (!after.size) return true;
  let shared = 0;
  for (const w of after) if (before.has(w)) shared++;
  return shared / before.size < keep;
}
