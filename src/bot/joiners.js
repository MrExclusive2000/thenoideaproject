import { InlineKeyboard } from 'grammy';
import { db, now } from '../db/db.js';
import { getSetting } from '../settings.js';
import { hub } from './hub.js';
import { isAdminUser } from './helpers.js';
import { audit } from '../util.js';

// New-member vetting: every non-admin joiner is tracked; after
// `group.vetDays` days without a linked customer account the admin gets a
// Keep/Remove DM. Remove = kick WITHOUT ban (they can be re-invited).

export function recordJoin(chatId, user, invitedBy = null) {
  if (!user || user.is_bot) return;
  if (isAdminUser(user.id)) return;
  const existing = db.prepare('SELECT * FROM group_joiners WHERE chat_id = ? AND tg_user_id = ?').get(chatId, user.id);
  if (existing) {
    // Already vetted positively — don't restart the clock on a rejoin.
    if (['kept', 'linked'].includes(existing.status)) return;
    db.prepare(`UPDATE group_joiners SET status = 'pending', joined_at = ?, asked_at = NULL, decided_at = NULL,
                tg_username = ?, first_name = ?, invited_by = COALESCE(?, invited_by) WHERE id = ?`)
      .run(now(), user.username || null, user.first_name || null, invitedBy, existing.id);
    return;
  }
  db.prepare('INSERT INTO group_joiners (chat_id, tg_user_id, tg_username, first_name, invited_by, joined_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(chatId, user.id, user.username || null, user.first_name || null, invitedBy, now());
}

export function markLeft(chatId, userId) {
  db.prepare("UPDATE group_joiners SET status = 'left' WHERE chat_id = ? AND tg_user_id = ? AND status IN ('pending', 'asked')")
    .run(chatId, userId);
}

function displayName(j) {
  return j.tg_username ? `@${j.tg_username}` : (j.first_name || String(j.tg_user_id));
}

// Runs on a timer: clears joiners who signed up (linked a customer account),
// asks the admin about the rest once they're overdue.
export async function vetSweep() {
  const days = Number(getSetting('group.vetDays')) || 0;
  if (!days || !hub.online) return;
  const due = db.prepare("SELECT * FROM group_joiners WHERE status = 'pending' AND joined_at < ?")
    .all(now() - days * 86400);

  for (const j of due) {
    if (db.prepare('SELECT 1 FROM customers WHERE telegram_user_id = ?').get(j.tg_user_id)) {
      db.prepare("UPDATE group_joiners SET status = 'linked', decided_at = ? WHERE id = ?").run(now(), j.id);
      continue;
    }
    const chat = db.prepare('SELECT title FROM allowed_chats WHERE chat_id = ?').get(j.chat_id);
    const daysIn = Math.floor((now() - j.joined_at) / 86400);
    const invitedBy = j.invited_by ? `\nInvited by user ${j.invited_by}.` : '';
    const kb = new InlineKeyboard().text('✅ Keep', `vet:keep:${j.id}`).text('🚪 Remove', `vet:remove:${j.id}`);
    const ids = getSetting('reports.adminTelegramIds') || [];
    let asked = false;
    for (const adminId of ids) {
      try {
        await hub.api.sendMessage(
          adminId,
          `👤 Member check: ${displayName(j)} joined ${chat?.title || j.chat_id} ${daysIn} day${daysIn === 1 ? '' : 's'} ago and hasn't linked a customer account.${invitedBy}\n\nKeep them, or remove? (Remove kicks without banning — they can be invited back.)`,
          { reply_markup: kb }
        );
        asked = true;
      } catch (err) {
        console.error('vet ask failed:', err.message);
      }
    }
    if (asked) db.prepare("UPDATE group_joiners SET status = 'asked', asked_at = ? WHERE id = ?").run(now(), j.id);
  }
}

export function registerVetActions(bot) {
  bot.callbackQuery(/^vet:(keep|remove):(\d+)$/, async (ctx) => {
    if (!isAdminUser(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Admins only.' });
    const action = ctx.match[1];
    const j = db.prepare('SELECT * FROM group_joiners WHERE id = ?').get(ctx.match[2]);
    if (!j) return ctx.answerCallbackQuery({ text: 'Not found any more.' });
    const name = displayName(j);

    if (action === 'keep') {
      db.prepare("UPDATE group_joiners SET status = 'kept', decided_at = ? WHERE id = ?").run(now(), j.id);
      audit('admin', String(ctx.from.id), 'joiner.keep', `${name} in ${j.chat_id}`);
      await ctx.answerCallbackQuery({ text: 'Kept.' });
      await ctx.editMessageText(`✅ Kept ${name} — I won't ask about them again.`).catch(() => {});
      return;
    }

    try {
      // ban + immediate unban = kick without ban: they can be re-invited.
      await ctx.api.banChatMember(j.chat_id, j.tg_user_id);
      await ctx.api.unbanChatMember(j.chat_id, j.tg_user_id);
      db.prepare("UPDATE group_joiners SET status = 'removed', decided_at = ? WHERE id = ?").run(now(), j.id);
      audit('admin', String(ctx.from.id), 'joiner.remove', `${name} from ${j.chat_id}`);
      await ctx.answerCallbackQuery({ text: 'Removed.' });
      await ctx.editMessageText(`🚪 Removed ${name} (not banned — they can be invited back).`).catch(() => {});
    } catch (err) {
      await ctx.answerCallbackQuery({ text: 'Failed — see message.' });
      await ctx.editMessageText(
        `❌ Could not remove ${name}: ${String(err.message || err).slice(0, 150)}\n\nMake me a group admin with permission to ban/remove members, then use the buttons on my next check.`
      ).catch(() => {});
      db.prepare("UPDATE group_joiners SET status = 'pending', asked_at = NULL WHERE id = ?").run(j.id);
    }
  });
}
