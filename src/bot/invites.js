import { db } from '../db/db.js';
import { chatAllowed, withAdminContact } from './helpers.js';

// "I want to invite my friend" is a sales conversation, and it used to go to
// the model. The model does not have an invite link, cannot make one, and has
// no idea how a friend gets an account — so it invented all three: it asked
// the customer for their username AND PASSWORD, then handed back
// "https://exclusiveexclusive.com/invite?username=…&password=…" and told them
// to send it to a friend. A made-up domain, the customer's credentials in a
// query string, and a support bot teaching people that handing over a
// password is normal. Nothing about that is recoverable by a better prompt.
//
// So this never touches the model. The real invite link comes from Telegram,
// the rest of the message is written here, and the one true answer — their
// friend needs their own account from the admin — is a constant.
// Someone other than the sender. Required by every shape below except the
// ones that name the group link outright — without it "can I invite you to
// my party?" came back with a real invite link to the group.
const PERSON =
  '(?:friend|friends|mate|mates|m8|pal|bro|brother|sis|sister|missus|wife|husband|partner|dad|mum|mom|son|daughter|cousin|nephew|niece|neighbour|neighbor|colleague|workmate|someone|somebody|a few people|people|another person)';

const INVITE_SHAPES = [
  // "invite/refer my mate", "add a friend"
  new RegExp(String.raw`\b(?:invite|refer|add|sign up|get)\b[^.?!\n]{0,30}\b${PERSON}\b`, 'i'),
  // "my mate wants to join", "my brother is interested in signing up"
  new RegExp(String.raw`\b${PERSON}\b[^.?!\n]{0,40}\b(?:wants?|wanted|would like|fancies|is interested|interested|asking about|asked about)\b[^.?!\n]{0,30}\b(?:to join|joining|join|the service|signing up|sign up|in on this|a sub|subscription|an account)\b`, 'i'),
  // "how can I get my brother on this / onto the service"
  new RegExp(String.raw`\b(?:get|put)\b[^.?!\n]{0,25}\b${PERSON}\b[^.?!\n]{0,20}\b(?:on|onto|in on|signed up|set up)\b`, 'i'),
  // The link itself, by name.
  /\bgroup (?:invite|link)\b|\bjoin(?:ing)? link\b|\binvite link (?:for|to) the group\b/i,
];

export function looksLikeInviteRequest(text) {
  const t = String(text || '');
  if (!t.trim() || t.length > 200) return false;
  return INVITE_SHAPES.some((re) => re.test(t));
}

// The group the bot supports. In a group chat it is that chat; in a DM it is
// the first adopted one.
function inviteTarget(ctx) {
  if (ctx.chat?.type !== 'private') {
    if (!chatAllowed(ctx.chat.id)) return null;
    return { chatId: ctx.chat.id, title: ctx.chat.title || 'the group' };
  }
  const chat = db.prepare('SELECT chat_id, title FROM allowed_chats WHERE enabled = 1 ORDER BY added_at LIMIT 1').get();
  if (!chat) return null;
  return { chatId: chat.chat_id, title: chat.title || 'the group' };
}

// Builds the invite message. Every word of it is written here — the link
// comes from Telegram's API, and the "they need their own login" line is not
// optional, because it is the entire reason a friend cannot just use the
// inviter's account. Returns null when no group is connected; throws nothing.
export async function buildInvite(ctx) {
  const target = inviteTarget(ctx);
  if (!target) return { ok: false, reason: 'no-group' };
  try {
    // Named after the inviter so joins through it are attributed for vetting.
    const link = await ctx.api.createChatInviteLink(target.chatId, {
      name: `ref:${ctx.from.id}`.slice(0, 32),
      member_limit: 1,
    });
    return {
      ok: true,
      text:
        `🎟 Here's a personal invite to ${target.title} for one friend:\n${link.invite_link}\n\n` +
        'It works exactly once. Send them that link and tell them to ' +
        withAdminContact('{admin}') +
        ' once they\'re in — the admin sets up their account and sorts the payment. ' +
        'They\'ll need their own login; accounts are one person each, so sharing yours would knock you both offline.',
    };
  } catch {
    return { ok: false, reason: 'no-permission' };
  }
}

export const INVITE_NO_GROUP = 'No group connected yet.';
export const INVITE_NO_PERMISSION =
  'I can\'t create invite links yet — an admin needs to make me a group admin with the "invite users via link" permission.';
