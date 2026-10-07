# Admin guide

Everything the panel and the bot can do, section by section.

## Dashboard
Live bot status (online / no token / error / **conflict** = same token running twice), messages seen and answered in 24h, AI calls against the daily budget, active customers, downloads, and a **setup checklist** that disappears once you're fully configured. "Needs attention" links you to unanswered questions and customers expiring within 7 days.

## Bot settings
- **Enabled / DM toggle** — master switches.
- **Response mode** — *mentions only*, *questions & problem reports* (default: answers when mentioned, when a message looks like a question, when it reads like a problem report such as "buffering on bbc1" / "purple not working", or when a FAQ matches it confidently), or *everything*. General conversation is left alone: statements without question/problem shape are never touched, generic words like "down"/"problem" only count when the service is also mentioned ("calm down mate" is safe), and off-topic questions mid-banter are silently dropped by the AI's on-topic check. In a very chatty group, switch to *mentions only* to stop the bot evaluating every question-shaped message. Photos/videos/voice notes: the bot can't read them — in a DM (or when a group photo replies to the bot) it asks the sender to type it out instead; captions are read as normal messages; members sharing photos with each other are never interrupted.
- **Instructions** — the AI's persona/system prompt. Describe the app, the tone, refund policy, whatever it should know and how it should behave. FAQs and guides are appended automatically as knowledge.
- **AI-reworded replies** — the canned messages (greeting, thanks, brush-off, closes, nudges) are reworded by the AI in fresh words each time so the bot doesn't repeat itself; your saved text stays the meaning and the guaranteed fallback (AI off/busy/slow/wrong → your exact text). Messages carrying URLs, codes or the auto-close notice are never reworded. Toggle on the Bot settings page.
- **Off-topic behaviour** — the AI is hard-instructed to answer **only** app questions; anything else it flags internally and the bot either stays silent (default) or sends your short redirect line. In redirect mode the **banter free pass** answers each user's FIRST off-topic question with one short friendly line (never a question back); any more within the window get the redirect message. Set the window to 0 to always brush off.
- **Fallback message** — sent when nothing matched and the AI is off/unreachable (empty = silence).
- **Welcome message** — greet new group members (`{name}` placeholder).
- **Cooldown** — seconds between answers to the same user (spam brake).
- **FAQ threshold** — only used as the fallback path (see AI settings). How confident a keyword match must be to answer without the AI, when the AI or the embedding model is unavailable.
- **Banned words** — messages containing them are never answered; AI output containing them is suppressed; optional alert to you.
- **Problem reports (multi-round triage, group and DM)** — when someone reports an issue ("buffering on bbc1"), the bot answers with the fixes first and invites them to confirm; a confirmed "still broken" gets further rounds of different steps (configurable, default 2 rounds) before it escalates: the user gets a "flagged to the team" ack and you get a batched Telegram DM. A confirmation that arrives suspiciously fast (within the configurable nudge window, default 3 minutes — the fixes take minutes to actually try) gets one friendly "give them a real go first" pushback instead; the next confirmation escalates regardless. The nudge is skipped when they give details (channel + time), report a specific check as fine, or when you've set a known service issue. Separately, 3+ different people reporting within 15 minutes triggers an immediate outage alert. All messages are editable here; the alert toggle lives in Reports & status; reports land on the Problem reports page.
- **New-member vetting** — members can bring a friend with `/invite` (a personal one-use link; the join is attributed to them). Every non-admin joiner is tracked, and after the configured number of days (0 = off) anyone who hasn't linked a customer account gets you a DM with **Keep / Remove** buttons — Remove kicks without banning, so they can be invited back; people who sign up (/link) in time are cleared silently. Needs the bot to be a group admin with invite + remove-member permissions.
- **Connected chats** — the allowlist. The bot only ever answers in chats you've adopted (send `/adopt` in the group). Mute/remove here.

## AI settings
Endpoint (OpenAI-compatible), model, optional key, max tokens, temperature, **daily call budget** (0 = unlimited; when hit, the bot answers FAQ-only until midnight UTC and alerts you once). **Test connection** sends a one-token ping, shows the latency, and separately checks the embedding model.

**Understanding questions.** With this on, the AI writes every answer and your FAQs become the knowledge it answers *from*, retrieved by meaning. Previously a keyword match fired a canned FAQ, and two of an FAQ's keywords landing in an unrelated sentence was enough — so the FAQ regularly answered a question nobody asked. Pull the model once on your node (`ollama pull nomic-embed-text`); it's small and fast even on CPU, because embedding a question is a single pass, not a generated answer. If it isn't available the bot falls back to keyword matching automatically, so nothing breaks — **Test connection** tells you which mode you're actually in.

**Answer reuse.** The same questions get asked forever in a support group. When a new question means essentially the same thing as one already answered, the stored answer is sent instantly instead of the node spending minutes rewriting it. This is what makes AI-for-everything affordable on a CPU node — it doesn't make a genuinely new question any faster. A 👎 drops that answer, and editing any FAQ or guide retires every answer written before the edit. Default similarity is 0.95 (near-identical wording); lower it to reuse more and risk answering a question that was merely similar.

## FAQ manager
Add question + answer + **keywords**. With *Understanding questions* on, keywords are context that helps the entry be found by meaning rather than a trigger that fires it — so you can write them without worrying that a stray word will serve the wrong FAQ. They are still the primary signal in the keyword fallback. Priority breaks ties. The **test box** scores any phrasing live against the keyword matcher. Hits are counted so you can see what matters.

## Is the server up to date?

Send the bot **`/version`** as an admin. It reports the commit and date actually running, the branch, how long it's been up, and then checks GitHub for newer commits on that branch.

The answer that matters is the last line: either *"Up to date"*, or *"N newer commits available"* — and in the second case it tells you whether restarting will actually pick them up, because that depends on the **auto-update** variable in the server's Startup tab. With auto-update off, restarting looks like it should update and doesn't, which is the easiest way to think you've deployed something you haven't.

It also warns if the checkout has local edits, since a restart with auto-update on discards them.

Same information in the panel under **Branding & backup → Version**, with a **Check for updates** button. The check costs a network round trip so it runs on request, not on every page load, and the result is cached for a few minutes.

`/version` still answers the old way for customers — service status and the latest app build — so nothing changed for them.

## Closing cases from Telegram

Every problem report has a case number, and the alert DMs now print it (`• #12 @punter: "bbc one keeps buffering"`). You are usually in Telegram when you find out something is fixed — you have just restarted something, or the customer told you directly — so you can close it there:

- **`#12 fixed`** — anywhere, group or DM. Also accepts sorted / resolved / done / working / back up.
- **Reply "fixed"** to an alert and it takes the case number from the alert itself. If that alert named several cases it asks which one rather than guessing.
- **`/case 12`** shows a case, **`/case 12 fixed`** closes it, **`/cases`** lists what's open.

Closing this way is identical to clicking Resolve in the panel: the reporter gets told it's fixed, and it's recorded in the audit log. Only admin Telegram IDs can do it — a member naming someone else's case number is ignored. An admin saying "that should be fixed now" with no case number closes nothing.

## When several people report the same thing

Once `problems.degradeThreshold` different people report service-wide problems inside the window (default 3 in 15 minutes — complaints about one episode or film never count), the bot decides it's a general problem rather than three unlucky customers:

- Service status flips to **degraded** with a note naming what's being reported. `/status`, the portal and the AI's own prompt all pick it up.
- **Anyone reporting after that is told it's known** instead of being walked through fixes. Restarting an app can't fix a fault on your side, and asking someone to do it during an outage wastes their evening and makes the bot look deaf. They still get a sentence or two in case theirs is genuinely unrelated.
- Extra troubleshooting rounds and the "that was quick" nudge are both skipped.
- Escalations to you are batched rather than one DM per person.
- It clears itself after a quiet period. A status you set by hand is never touched.

**Nothing is posted to your group automatically.** The threshold is a heuristic, and a false positive would put "we have an outage" in front of paying customers with nobody checking — so the DM you get carries an **Announce to the group** button. One tap posts it; the buttons disappear once used so a second tap can't double-post. The all-clear works the same way when the status clears, so the group hears it's fixed rather than being left wondering.

Both messages are editable in **Reports & status**; `{note}` is replaced with the bot's own summary of what people are reporting. Empty announcement text means the bot never offers to post.

## Learning from cases

A problem report is a case: it opens when someone reports an issue, follow-up messages attach to it, and it closes when they say it's sorted, when you resolve it in the panel, or on the auto-close timer. The conversation is stored, so a restart no longer loses the thread, and a reply the next morning still lands on the right case (window: `bot.problemWindowMinutes`, default 12h). A problem about something clearly different opens its own case rather than piling onto the open one.

That makes two kinds of knowledge fall out of the cases themselves:

- **Fixes that demonstrably worked.** When a customer comes back and confirms their problem is fixed, whatever the bot last told them worked — on a real device, for a real problem. Once *two or more* people have confirmed the same fix for the same problem, it's drafted as a pending FAQ (badged "confirmed fixed"). One confirmation is an anecdote and is ignored.
- **Problems nothing fixes.** Topics reported over and over that get escalated, closed by you, or time out appear under **Never actually getting fixed** on the Problem reports page. These are deliberately *not* drafted: the bot already had an answer and it didn't work, so drafting from it would just publish the failure. Write the real fix, or the service needs looking at.

Turn both off with `suggest.fromCases`.

## Learning from your own answers
The bot records every message it can see in your groups, including yours. Once a week (or on demand from **FAQ manager → Learn from my answers now**) it looks for questions **you** answered in the group and drafts FAQ entries from them.

This is the other half of the Unanswered inbox. That one learns from what the bot got *wrong* and leaves `[ADMIN: fill this in]` wherever the real answer needs something only you know. This learns from what you got *right*, so the answer already exists — the AI only generalises the wording.

The risk runs the opposite way, so:

- **Nothing is ever enabled automatically.** Drafts land in the same pending queue and wait for you.
- **Per-person detail is flagged, not hidden.** A draft mentioning a long number, a date, a @handle, a price or someone's account is marked ⚠️ with the reason. An FAQ is shown to everyone, so read those before approving.
- **Credentials and email addresses are dropped outright**, and so are one-word acknowledgements, emoji and "sorted mate" — they are not knowledge.
- **If the AI judges an exchange too specific to generalise, the draft is abandoned** rather than falling back to your raw words.

It relies on you using Telegram's **reply** action — that link is what ties your answer to the question it answered. An answer typed without replying is still logged on the Conversations page, but nothing can tell what it was answering.

Turn it off with `suggest.fromAnswers`.

## Unanswered inbox
Everything the bot couldn't answer (no FAQ match + AI declined/off-topic) and every answer a user rated 👎. **Make FAQ** converts an entry into a disabled draft FAQ prefilled with the question — write the answer, enable, done.

## Downloads
Upload APKs (and zip/ipa/exe/pdf/txt/mp4). Files are checked by real content (an "apk" that isn't a ZIP is rejected), stored under random names, hashed (SHA-256 shown to customers), and served only through authenticated routes. Mark one file **latest** — that's what `/version` and `/download` use. **Auto-announce** posts new uploads to the group. **Short codes**: mint `ABC123`-style codes (expiring, limited uses, optionally tied to a customer) — customers type `your-address/d/ABC123` into the Downloader app and the APK just downloads.

## Guides
Markdown editor with preview. Visible guides appear in the portal and are folded into the bot's AI knowledge, and the bot serves them in chat via `/guides`.

## Customers
Create one shared login or bulk accounts (`name01`, `name02`, …) — passwords are generated and **shown exactly once**. Set access length in days, extend with one click (+30/+90/+1y/exact date/never), disable, reset password, delete. Filters for *expiring ≤7d*, *expired*, *disabled*. Each customer page shows download history and the **Telegram link**. Linking drives expiry-reminder DMs, new-member vetting and download attribution, so it is worth doing. There is no self-service code any more (that was `/link`): ask the customer to send the bot `/id` in a private message and paste the number it gives them into the customer page.

## Conversations
Every message the bot can see in your groups is recorded — members, admins, and the bot's own answers. Replies are threaded using Telegram's reply link, so an answer you type in the group stays attached to the question it answered.

Three views: **Answered** (question + every reply it got), **Nobody answered** (each one is a missing FAQ or a customer who gave up), and the **raw log**. Export either the threaded Q&A or every message as JSONL.

Kept indefinitely by default — this is the record new FAQ entries get written from. Turn `retention.keepConversations` off to go back to 30-day pruning.

## Getting a human
There is no ticket system. Set **your Telegram handle** in Bot settings and anything the bot can't answer points there. Write `{admin}` in any bot message, FAQ answer or guide and it becomes "message @you directly"; leave the handle empty and it reads "message an admin directly" instead.

## Broadcasts
Send an announcement to every connected chat, with history and per-chat delivery results. Admins can also `/broadcast <text>` straight from Telegram.

## Reports & status
- **Service status** — operational / degraded / maintenance + note. Shown in the portal and `/status`; optionally auto-announced to the group on change.
- **Admin Telegram IDs** — who receives alerts, digests, and may use admin bot commands (`/adopt`, `/report`, `/broadcast`, `/mute`, `/unmute`, `/id`). Each admin must `/start` the bot once.
- **Alerts** — bot/AI errors, budget reached, problem reports, banned words. Throttled so a flapping error can't spam you.
- **AI digest** — daily or weekly: the AI reads the period's stats (answered/unanswered, ratings, downloads, expiring customers, trending questions) and writes you a short report, delivered by DM and archived on this page. *Generate digest now* for an instant one; `/report` in Telegram does the same.
- Expiry-reminder lead time and message-log retention live here too.

## Admins
Owner can add admins (generated password shown once, forced change at first login), reset passwords (also clears their 2FA), and delete. Everyone can enable **TOTP 2FA** on the Password & 2FA page.

## Audit log
Every login (including failures), setting change, upload, download, customer change, broadcast and backup — with actor, IP and timestamp. Kept one year.

## Branding & backup
App name + accent color + logo (shown across panel, portal and login screens). **Download database backup** produces a consistent SQLite snapshot; grab `data/uploads` via the Pelican file manager for the binaries. Restore = stop server, replace `data/app.db`, start.

## Bot commands (customer side)
`/start` menu with buttons · `/help` · `/status` & `/version` (service state + latest version) · `/faq` · `/guides` (button list, sent as chat text) · `/invite` · `/download` (sends the APK right in the DM when ≤48 MB, otherwise quotes your Downloader/aftv.news code). Every FAQ/AI answer carries 👍/👎 buttons.
