# Admin guide

Everything the panel and the bot can do, section by section.

## Dashboard
Live bot status (online / no token / error / **conflict** = same token running twice), messages seen and answered in 24h, AI calls against the daily budget, active customers, downloads, and a **setup checklist** that disappears once you're fully configured. "Needs attention" links you to open tickets, unanswered questions and customers expiring within 7 days.

## Bot settings
- **Enabled / DM toggle** — master switches.
- **Response mode** — *mentions only*, *questions & problem reports* (default: answers when mentioned, when a message looks like a question, when it reads like a problem report such as "buffering on bbc1" / "purple not working", or when a FAQ matches it confidently), or *everything*.
- **Instructions** — the AI's persona/system prompt. Describe the app, the tone, refund policy, whatever it should know and how it should behave. FAQs and guides are appended automatically as knowledge.
- **Off-topic behaviour** — the AI is hard-instructed to answer **only** app questions; anything else it flags internally and the bot either stays silent (default) or sends your short redirect line.
- **Fallback message** — sent when nothing matched and the AI is off/unreachable (empty = silence).
- **Welcome message** — greet new group members (`{name}` placeholder).
- **Cooldown** — seconds between answers to the same user (spam brake).
- **FAQ threshold** — how confident a FAQ match must be to answer without AI. Test in the FAQ manager.
- **Banned words** — messages containing them are never answered; AI output containing them is suppressed; optional alert to you.
- **Connected chats** — the allowlist. The bot only ever answers in chats you've adopted (send `/adopt` in the group). Mute/remove here.

## AI settings
Endpoint (OpenAI-compatible), model, optional key, max tokens, temperature, **daily call budget** (0 = unlimited; when hit, the bot answers FAQ-only until midnight UTC and alerts you once). **Test connection** sends a one-token ping and shows the latency.

## FAQ manager
Add question + answer + **keywords** (the strongest matching signal — include slang and typos your users actually write). Priority breaks ties. The **test box** scores any phrasing live so you can tune entries. Hits are counted so you can see what matters.

## Unanswered inbox
Everything the bot couldn't answer (no FAQ match + AI declined/off-topic) and every answer a user rated 👎. **Make FAQ** converts an entry into a disabled draft FAQ prefilled with the question — write the answer, enable, done.

## Downloads
Upload APKs (and zip/ipa/exe/pdf/txt/mp4). Files are checked by real content (an "apk" that isn't a ZIP is rejected), stored under random names, hashed (SHA-256 shown to customers), and served only through authenticated routes. Mark one file **latest** — that's what `/version` and `/download` use. **Auto-announce** posts new uploads to the group. **Short codes**: mint `ABC123`-style codes (expiring, limited uses, optionally tied to a customer) — customers type `your-address/d/ABC123` into the Downloader app and the APK just downloads.

## Guides
Markdown editor with preview. Visible guides appear in the portal and are folded into the bot's AI knowledge, and the bot serves them in chat via `/guides`.

## Customers
Create one shared login or bulk accounts (`name01`, `name02`, …) — passwords are generated and **shown exactly once**. Set access length in days, extend with one click (+30/+90/+1y/exact date/never), disable, reset password, delete. Filters for *expiring ≤7d*, *expired*, *disabled*. Each customer page shows download history, tickets, and the **Telegram link** flow (generate a code, customer DMs `/link CODE` to the bot). Linked customers get expiry-reminder DMs automatically and can use `/myaccount`, `/download`, `/ticket`.

## Tickets
DM conversations with the bot become tickets (explicitly via `/ticket`, or suggested when the bot can't answer a DM). Reply from the panel — it's delivered as a bot DM; their replies land back in the thread. Statuses: open (needs you) / pending (waiting on them) / closed (notifies them). New tickets and replies can alert you on Telegram.

## Broadcasts
Send an announcement to every connected chat, with history and per-chat delivery results. Admins can also `/broadcast <text>` straight from Telegram.

## Reports & status
- **Service status** — operational / degraded / maintenance + note. Shown in the portal and `/status`; optionally auto-announced to the group on change.
- **Admin Telegram IDs** — who receives alerts, digests, and may use admin bot commands (`/adopt`, `/report`, `/broadcast`, `/tickets`, `/mute`, `/unmute`, `/id`). Each admin must `/start` the bot once.
- **Alerts** — bot/AI errors, budget reached, new tickets, banned words. Throttled so a flapping error can't spam you.
- **AI digest** — daily or weekly: the AI reads the period's stats (answered/unanswered, ratings, downloads, expiring customers, trending questions) and writes you a short report, delivered by DM and archived on this page. *Generate digest now* for an instant one; `/report` in Telegram does the same.
- Expiry-reminder lead time and message-log retention live here too.

## Admins
Owner can add admins (generated password shown once, forced change at first login), reset passwords (also clears their 2FA), and delete. Everyone can enable **TOTP 2FA** on the Password & 2FA page.

## Audit log
Every login (including failures), setting change, upload, download, customer change, broadcast and backup — with actor, IP and timestamp. Kept one year.

## Branding & backup
App name + accent color + logo (shown across panel, portal and login screens). **Download database backup** produces a consistent SQLite snapshot; grab `data/uploads` via the Pelican file manager for the binaries. Restore = stop server, replace `data/app.db`, start.

## Bot commands (customer side)
`/start` menu with buttons · `/help` · `/status` & `/version` (service state + latest version + portal link) · `/faq` · `/guides` (button list, sent as chat text) · `/link CODE` · `/myaccount` / `/expiry` · `/download` (sends the APK right in the DM when ≤48 MB, otherwise a personal download code) · `/ticket` · `/close`. Every FAQ/AI answer carries 👍/👎 buttons.
