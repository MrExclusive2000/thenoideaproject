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
    .replace(/^#{1,6}\s+/gm, '');

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
  for (let i = 0; i < 3 && endsWithQuestion(out); i++) {
    // The decorations go with the question sentence they decorate.
    out = out.replace(TRAILING_DECOR, '');
    const lineIdx = out.lastIndexOf('\n');
    const head = lineIdx === -1 ? '' : out.slice(0, lineIdx + 1);
    const lastLine = out.slice(lineIdx + 1);
    // Keep any complete sentences on the last line before the question.
    const m = lastLine.match(/^([\s\S]*[.!:)])\s*[^.!?\n]*\?$/);
    const candidate = (head + (m ? m[1] : '')).trimEnd();
    // Nothing of substance left → the reply IS the clarifying question.
    if (candidate.length < 25) return out;
    out = candidate;
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

export function containsBannedWord(text, bannedWords) {
  if (!text || !bannedWords?.length) return false;
  const lower = text.toLowerCase();
  return bannedWords.some((w) => w && lower.includes(String(w).toLowerCase()));
}
