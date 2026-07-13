# Setup guide (Pelican Panel)

Follow this top to bottom and you'll be live in ~15 minutes.

## 1. What you need before starting

| Thing | Where to get it |
|---|---|
| Telegram bot token | @BotFather on Telegram (steps below) |
| GitHub username + PAT | github.com → Settings → Developer settings (steps below) |
| Llama endpoint URL | Your Ollama install, e.g. `http://127.0.0.1:11434/v1` |
| A Pelican port allocation | Your panel admin area |
| Your Telegram user ID | Message `@userinfobot` on Telegram — it replies with your ID |

## 2. Create the Telegram bot (BotFather)

1. Open Telegram, message **@BotFather** → send `/newbot`.
2. Pick a name (e.g. *MyApp Support*) and a username (must end in `bot`).
3. Copy the **token** it gives you (looks like `1234567:AAE...`).
4. **Important — let the bot read your group:** send `/mybots` → pick your bot → **Bot Settings** → **Group Privacy** → **Turn off**. Without this the bot cannot see normal group messages and will answer nothing.
5. (Optional) `/setuserpic` for a logo, `/setdescription` for a blurb.

## 3. Create the GitHub token (the repo is private)

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → *Generate new token*.
2. Repository access: **Only select repositories** → pick this repo.
3. Permissions: **Contents → Read-only**. Nothing else.
4. Generate and copy the token (starts with `github_pat_`).

## 4. Import the egg into Pelican

1. Download `egg/egg-support-suite.json` from this repo.
2. Pelican admin area → **Eggs** → **Import Egg** → upload the file.
   (Pterodactyl works too: Nests → Import Egg.)

## 5. Create the server

1. **Create server** from the *Telegram Support Suite* egg, give it a port allocation and modest resources (512 MB RAM is plenty; disk depends on how many APKs you store).
2. Fill in the variables:
   - `TELEGRAM_BOT_TOKEN` — from step 2
   - `GITHUB_USERNAME` / `GITHUB_PAT` — from step 3
   - `AI_BASE_URL` — your Ollama endpoint. If Ollama runs on the same machine as the Wings node use `http://172.17.0.1:11434/v1` (Docker gateway) or the node's LAN IP — `127.0.0.1` inside the container is the container itself, not the node.
   - `AI_MODEL` — e.g. `llama3.1`
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD` — your first panel login (leave the password empty to have one generated and printed once in the console)
   - `PUBLIC_URL` — how customers reach the portal, e.g. `http://YOUR-NODE-IP:PORT`
3. Install runs automatically — it is fully non-interactive and never asks for console input. Then start the server.
4. Console shows `Panel listening on ...` when it's up.

> **Ollama note:** make sure Ollama listens on an address the container can reach (`OLLAMA_HOST=0.0.0.0` on the node) and that the model is pulled (`ollama pull llama3.1`).

## 6. First login & go-live checklist

Open `http://YOUR-NODE-IP:PORT/admin/login`:

1. Log in → you're forced to set a new password. Do it. (Optionally enable 2FA on the same page.)
2. The **dashboard shows a setup checklist** — work through it:
   - **Reports & status** → paste your Telegram user ID(s) into *Admin Telegram IDs* → save. Send the bot a `/start` DM once (Telegram forbids bots to DM first), then use *Send test alert*.
   - Add the bot to your Telegram group, then send **`/adopt`** in the group (from your admin account). The bot only ever answers in adopted chats.
   - **AI settings** → *Test connection* until it's green.
   - **FAQ manager** → add your top 10 questions (keywords matter — they make matching sharp).
   - **Bot settings** → write the bot's instructions (what the app is, tone, rules).
   - **Downloads** → upload your APK, mark it *latest*.
   - **Guides** → write "Install on Firestick" and friends.
   - **Customers** → create accounts (single shared or bulk); passwords are generated and shown once.
3. Test as a customer: log in at `http://YOUR-NODE-IP:PORT/login` on your phone, and try a `/d/CODE` download code in the Downloader app on a Firestick.

## 7. Updating

Push changes to the repo, then either restart with the `AUTO_UPDATE` variable set to `1`, or hit **Reinstall** in Pelican (safe: `data/` — your database, uploads and settings — is never touched by install or reinstall).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bot shows *conflict* on the dashboard | The same token is polling somewhere else (old server still running?). Stop the other instance, restart this one. |
| Bot online but ignores group messages | Group Privacy is still on (step 2.4), or you never sent `/adopt` in the group, or the chat is muted in Bot settings. |
| AI test fails | Wrong `AI_BASE_URL` (remember `/v1`), Ollama not reachable from the container, or model not pulled. |
| Console printed no admin password | You set `ADMIN_PASSWORD` yourself; otherwise scroll the install/first-boot log. |
| Download code page says invalid | Codes expire and have limited uses — mint a new one in Downloads. |
