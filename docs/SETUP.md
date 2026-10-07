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
>
> **Ollama on a CPU node — set these env vars, or the AI will time out with 500s:**
> - `OLLAMA_CONTEXT_LENGTH=8192` — the default context (often ~2048–4096) is too small for the support prompt; an overflowing prompt gets truncated mid-template and Ollama returns a 500.
> - `OLLAMA_NUM_PARALLEL=1` — otherwise Ollama splits the context between slots (halving the usable window). One request at a time is right for a CPU model anyway.
> - `OLLAMA_KEEP_ALIVE=-1` — keeps the model resident so it doesn't reload (a ~12s stall) between messages.
>
> The bot already keeps its prompt small by sending only the FAQs relevant to each question (not your whole FAQ list), so a 7B model on CPU won't overflow the context.
>
> **Pull the embedding model too:** `ollama pull nomic-embed-text`. It's what lets the bot find the right FAQs by meaning instead of by keyword, and it's cheap — embedding a question is a single pass, not a generated answer. It also powers answer reuse, which is the difference between repeat questions costing minutes and costing nothing. Without it the bot still works, just on the old keyword matching.
>
> **If answers time out (Ollama 500s even with a small prompt), the node is generating too slowly, not overflowing.** CPU generation is ~4 tokens/sec for a 7B model, so a full answer needs 60-90s. Two fixes:
> - **AI settings** → set **timeout** to `180`s and **max answer length** to `220` tokens (these are the defaults now, but confirm them if you saved AI settings on an older build).
> - **Use a smaller model** — a 3B (`qwen2.5:3b`, `llama3.2:3b`) generates 2-3× faster on CPU and answers support questions fine. This is the single biggest speed win. Also check the node isn't low on RAM (a 7B model that swaps crawls). Avoid `gemma*` on CPU — it re-reads the whole prompt every message.
> - On a slow node, turn **AI-reworded replies** OFF (Bot settings) — it adds a second generation to every greeting/thanks. The saved text still sends instantly.
>
> ### If Ollama runs as its own Pelican egg
>
> A Pelican server has no shell you can type `ollama pull` into, and the env vars above are not egg variables — both live in the **startup command**. A typical Ollama egg pulls exactly one model (`$OLLAMA_MODEL`) and exports nothing else, which means `nomic-embed-text` is never fetched and the model unloads after 5 idle minutes, so a quiet group pays a full reload on every question.
>
> Edit the egg's **Startup** command (Pelican admin → Nests/Eggs → your Ollama egg) to export the tuning vars and pull both models:
>
> ```bash
> bash -c 'export OLLAMA_HOST=0.0.0.0:{{SERVER_PORT}}; export OLLAMA_MODELS=/home/container/.ollama/models; export LD_LIBRARY_PATH=/home/container/lib/ollama; export OLLAMA_KEEP_ALIVE=-1; export OLLAMA_NUM_PARALLEL=1; export OLLAMA_CONTEXT_LENGTH=8192; export OLLAMA_MAX_LOADED_MODELS=2; /home/container/bin/ollama serve & SRV=$!; until curl -s http://127.0.0.1:{{SERVER_PORT}}/api/tags >/dev/null 2>&1; do sleep 1; done; for M in "$OLLAMA_MODEL" "$OLLAMA_EMBED_MODEL"; do [ -n "$M" ] && { /home/container/bin/ollama list | grep -q "^$M[[:space:]]" || /home/container/bin/ollama pull "$M"; }; done; wait $SRV'
> ```
>
> Then add a second egg **variable** so the embedding model is configurable like the chat one:
>
> | Field | Value |
> |---|---|
> | Name | `Embedding model` |
> | Env variable | `OLLAMA_EMBED_MODEL` |
> | Default value | `nomic-embed-text` |
> | Rules | `nullable|string` |
>
> `OLLAMA_MAX_LOADED_MODELS=2` matters here: with `KEEP_ALIVE=-1` and two models in play, Ollama must be allowed to hold both resident or it will evict the chat model every time it embeds a question. Budget ~300MB for `nomic-embed-text` on top of your chat model.
>
> Two things to check in the egg while you're in there:
> - **Does the install exclude the GPU libraries?** (`--exclude='lib/ollama/cuda*'`) If so the server is CPU-only by construction and no amount of tuning will change that — the model size is your only speed lever.
> - **The "already pulled?" test.** `ollama list | grep -q "${OLLAMA_MODEL%%:*}"` strips the tag, so switching `llama3.1:8b` → `llama3.1:70b` sees `llama3.1` already present and silently keeps serving the old one. Matching the full `name` column (as above) fixes it.

## 6. First login & go-live checklist

Open `http://YOUR-NODE-IP:PORT/admin/login`:

1. Log in → you're forced to set a new password. Do it. (Optionally enable 2FA on the same page.)
2. The **dashboard shows a setup checklist** — work through it:
   - **Reports & status** → paste your Telegram user ID(s) into *Admin Telegram IDs* → save. Send the bot a `/start` DM once (Telegram forbids bots to DM first), then use *Send test alert*.
   - Add the bot to your Telegram group, then send **`/adopt`** in the group (from your admin account). The bot only ever answers in adopted chats.
   - **AI settings** → *Test connection* until it's green.
   - **FAQ manager** → add your top 10 questions (keywords still help — they give the matcher more of the words your users actually type).
   - **Bot settings** → set your **Telegram handle**, so anything the bot can't answer points at you. There is no ticket system.
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
