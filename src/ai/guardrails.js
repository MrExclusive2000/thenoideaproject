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
