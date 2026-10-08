// Versioned migrations tracked via PRAGMA user_version. Each entry runs once,
// in order, inside a transaction. Never edit an existing migration — append.
const migrations = [
  // v1 — initial schema
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE admins (
    id                   INTEGER PRIMARY KEY,
    username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash        TEXT NOT NULL,
    role                 TEXT NOT NULL DEFAULT 'admin',
    totp_secret          TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    failed_attempts      INTEGER NOT NULL DEFAULT 0,
    locked_until         INTEGER,
    last_login_at        INTEGER,
    created_at           INTEGER NOT NULL
  );

  CREATE TABLE customers (
    id               INTEGER PRIMARY KEY,
    username         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash    TEXT NOT NULL,
    display_name     TEXT,
    notes            TEXT,
    telegram_user_id INTEGER UNIQUE,
    active           INTEGER NOT NULL DEFAULT 1,
    expires_at       INTEGER,
    reminder_sent_at INTEGER,
    failed_attempts  INTEGER NOT NULL DEFAULT 0,
    locked_until     INTEGER,
    last_login_at    INTEGER,
    created_by       TEXT,
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE files (
    id            INTEGER PRIMARY KEY,
    stored_name   TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    original_name TEXT NOT NULL,
    description   TEXT,
    version       TEXT,
    category      TEXT,
    size          INTEGER NOT NULL,
    sha256        TEXT NOT NULL,
    visible       INTEGER NOT NULL DEFAULT 1,
    is_latest     INTEGER NOT NULL DEFAULT 0,
    uploaded_by   TEXT,
    uploaded_at   INTEGER NOT NULL
  );

  CREATE TABLE downloads (
    id          INTEGER PRIMARY KEY,
    file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    via         TEXT NOT NULL DEFAULT 'portal',
    ip          TEXT,
    ts          INTEGER NOT NULL
  );
  CREATE INDEX idx_downloads_file ON downloads(file_id, ts);

  CREATE TABLE guides (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    body_md    TEXT NOT NULL DEFAULT '',
    sort       INTEGER NOT NULL DEFAULT 0,
    visible    INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE faqs (
    id         INTEGER PRIMARY KEY,
    question   TEXT NOT NULL,
    answer     TEXT NOT NULL,
    keywords   TEXT NOT NULL DEFAULT '',
    enabled    INTEGER NOT NULL DEFAULT 1,
    priority   INTEGER NOT NULL DEFAULT 0,
    hit_count  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE unanswered (
    id               INTEGER PRIMARY KEY,
    text             TEXT NOT NULL,
    chat_id          INTEGER,
    chat_title       TEXT,
    tg_user          TEXT,
    near_miss_faq_id INTEGER,
    source           TEXT NOT NULL DEFAULT 'nomatch',
    resolved         INTEGER NOT NULL DEFAULT 0,
    ts               INTEGER NOT NULL
  );

  CREATE TABLE allowed_chats (
    chat_id  INTEGER PRIMARY KEY,
    title    TEXT,
    enabled  INTEGER NOT NULL DEFAULT 1,
    added_at INTEGER NOT NULL
  );

  CREATE TABLE banned_words (
    id   INTEGER PRIMARY KEY,
    word TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE broadcasts (
    id         INTEGER PRIMARY KEY,
    body       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    result     TEXT,
    sent_at    INTEGER,
    created_by TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE messages_log (
    id           INTEGER PRIMARY KEY,
    chat_id      INTEGER,
    tg_user_id   INTEGER,
    tg_username  TEXT,
    text         TEXT,
    reply_source TEXT,
    ts           INTEGER NOT NULL
  );
  CREATE INDEX idx_messages_chat_ts ON messages_log(chat_id, ts);
  CREATE INDEX idx_messages_ts ON messages_log(ts);

  CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY,
    actor_type TEXT NOT NULL,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT,
    ip         TEXT,
    ts         INTEGER NOT NULL
  );
  CREATE INDEX idx_audit_ts ON audit_log(ts);

  CREATE TABLE sessions (
    sid    TEXT PRIMARY KEY,
    sess   TEXT NOT NULL,
    expire INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_expire ON sessions(expire);

  CREATE TABLE tickets (
    id               INTEGER PRIMARY KEY,
    customer_id      INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    telegram_user_id INTEGER,
    tg_username      TEXT,
    subject          TEXT,
    status           TEXT NOT NULL DEFAULT 'open',
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );

  CREATE TABLE ticket_messages (
    id        INTEGER PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    sender    TEXT NOT NULL,
    body      TEXT NOT NULL,
    ts        INTEGER NOT NULL
  );

  CREATE TABLE link_codes (
    code        TEXT PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE download_codes (
    code        TEXT PRIMARY KEY,
    file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    max_uses    INTEGER NOT NULL DEFAULT 1,
    uses        INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER NOT NULL,
    created_by  TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE answer_feedback (
    id         INTEGER PRIMARY KEY,
    chat_id    INTEGER,
    message_id INTEGER,
    faq_id     INTEGER,
    source     TEXT,
    rating     TEXT NOT NULL,
    tg_user_id INTEGER,
    ts         INTEGER NOT NULL,
    UNIQUE(chat_id, message_id, tg_user_id)
  );

  CREATE TABLE ai_usage (
    day    TEXT PRIMARY KEY,
    calls  INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE digests (
    id         INTEGER PRIMARY KEY,
    period     TEXT,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // v2 — problem reports surfaced from the group so admins can spot outages
  `
  CREATE TABLE problem_reports (
    id         INTEGER PRIMARY KEY,
    chat_id    INTEGER,
    chat_title TEXT,
    tg_user_id INTEGER,
    tg_user    TEXT,
    text       TEXT NOT NULL,
    topic      TEXT,
    answered   INTEGER NOT NULL DEFAULT 0,
    resolved   INTEGER NOT NULL DEFAULT 0,
    ts         INTEGER NOT NULL
  );
  CREATE INDEX idx_problem_reports_ts ON problem_reports(ts);
  CREATE INDEX idx_problem_reports_open ON problem_reports(resolved, ts);
  `,
  // v3 — new-member vetting: track joiners, ask the admin after N days
  `
  CREATE TABLE group_joiners (
    id          INTEGER PRIMARY KEY,
    chat_id     INTEGER NOT NULL,
    tg_user_id  INTEGER NOT NULL,
    tg_username TEXT,
    first_name  TEXT,
    invited_by  INTEGER,
    joined_at   INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    asked_at    INTEGER,
    decided_at  INTEGER,
    UNIQUE(chat_id, tg_user_id)
  );
  CREATE INDEX idx_joiners_status ON group_joiners(status, joined_at);
  `,
  // v4 — escalated flag so auto-close never touches reports the admin was
  // pinged about
  `
  ALTER TABLE problem_reports ADD COLUMN escalated INTEGER NOT NULL DEFAULT 0;
  `,
  // v5 — which service the escalated problem is on (the bot asks the user
  // after escalating and stores their answer)
  `
  ALTER TABLE problem_reports ADD COLUMN service TEXT;
  `,
  // v6 — who closed a report: 'user' (said it's fixed), 'auto-close', 'admin'
  `
  ALTER TABLE problem_reports ADD COLUMN resolved_by TEXT;
  `,
  // v7 — AI-drafted FAQ suggestions from unanswered questions, scheduled
  // broadcasts, and the post-expiry upsell marker
  `
  CREATE TABLE suggested_faqs (
    id         INTEGER PRIMARY KEY,
    question   TEXT NOT NULL,
    answer     TEXT NOT NULL,
    keywords   TEXT,
    ask_count  INTEGER NOT NULL DEFAULT 1,
    samples    TEXT,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE scheduled_broadcasts (
    id           INTEGER PRIMARY KEY,
    body         TEXT NOT NULL,
    send_at      INTEGER NOT NULL,
    repeat       TEXT NOT NULL DEFAULT 'once',
    enabled      INTEGER NOT NULL DEFAULT 1,
    last_sent_at INTEGER,
    created_by   TEXT,
    created_at   INTEGER NOT NULL
  );
  ALTER TABLE customers ADD COLUMN upsell_sent_at INTEGER;
  `,
  // v8 — per-message ticket delivery state: 1 delivered, 0 stranded (bot
  // offline / user never DMed the bot), NULL for customer-sent messages
  `
  ALTER TABLE ticket_messages ADD COLUMN delivered INTEGER;
  `,
  // v9 — VOD requests captured from "Request: Title (Year)" messages
  `
  CREATE TABLE vod_requests (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    norm_title TEXT NOT NULL,
    tg_user_id INTEGER,
    tg_user    TEXT,
    chat_id    INTEGER,
    ask_count  INTEGER NOT NULL DEFAULT 1,
    status     TEXT NOT NULL DEFAULT 'open',
    ts         INTEGER NOT NULL
  );
  CREATE INDEX idx_vod_requests_status ON vod_requests(status, ts);
  `,
  // v10 — which service a VOD request is for (the bot asks after capturing)
  `
  ALTER TABLE vod_requests ADD COLUMN service TEXT;
  `,
  // v11 — off-topic questions are no longer recorded in the Unanswered inbox
  // (pure banter clutter); sweep out the rows older builds collected.
  `
  DELETE FROM unanswered WHERE source = 'offtopic';
  `,
  // v12 — CPU nodes generate at a few tokens/sec, so the old 90s timeout cut
  // answers off mid-generation (Ollama 500s). Installs that saved AI settings
  // on an older build kept 90s in the DB, overriding the new 180s default.
  // Raise a too-low saved timeout, and cap a too-high saved max_tokens, so
  // existing installs get the fix without touching the panel. Values are
  // stored as JSON scalars ("90"), which CAST reads fine. Only nudges toward
  // safety — never lowers a timeout or raises a token cap someone chose.
  `
  UPDATE settings SET value = '180' WHERE key = 'ai.timeoutSeconds' AND CAST(value AS INTEGER) < 180;
  UPDATE settings SET value = '220' WHERE key = 'ai.maxTokens' AND CAST(value AS INTEGER) > 220;
  `,
  // v13 — the message log becomes a real conversation record. It already
  // captured every message in an allowed group (members, admins and all),
  // but as flat rows: there was no way to tell that an admin's message was
  // the ANSWER to a member's question three messages earlier, which is the
  // only part worth harvesting. Telegram hands us reply_to_message on every
  // update and we were discarding it. bot_reply stores what the bot itself
  // said — reply_source only ever recorded HOW it answered, never the text.
  `
  ALTER TABLE messages_log ADD COLUMN tg_msg_id INTEGER;
  ALTER TABLE messages_log ADD COLUMN reply_to_tg_msg_id INTEGER;
  ALTER TABLE messages_log ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages_log ADD COLUMN bot_reply TEXT;
  ALTER TABLE messages_log ADD COLUMN chat_title TEXT;
  CREATE INDEX idx_messages_reply ON messages_log(chat_id, reply_to_tg_msg_id);
  CREATE INDEX idx_messages_tg_msg ON messages_log(chat_id, tg_msg_id);
  `,
  // v14 — /ticket, /link and /myaccount are gone; everyone needing a human is
  // sent to the admin instead. Existing installs have those commands baked
  // into FAQ answers, guides and canned messages written long before this, and
  // a bot that keeps telling customers to "send /ticket" at a command that no
  // longer replies is worse than one that says nothing. Rewrite the common
  // phrasings to the {admin} placeholder, which is expanded at send time from
  // bot.adminContact. Longest phrases first, so the bare-token fallback only
  // catches what the specific ones missed.
  `
  UPDATE faqs SET answer = replace(replace(replace(replace(replace(replace(replace(replace(replace(answer,
    'message the bot **/ticket** in a private chat', '{admin}'),
    'open a ticket with me in a private chat (/ticket)', '{admin}'),
    'Message me /ticket in a private chat', '{admin}'),
    'message me /ticket in a private chat', '{admin}'),
    'Message me /ticket', '{admin}'),
    'message me /ticket', '{admin}'),
    'send me /ticket', '{admin}'),
    'send /ticket', '{admin}'),
    '/ticket', 'the admin')
  WHERE answer LIKE '%/ticket%';

  UPDATE faqs SET answer = replace(replace(replace(replace(answer,
    'message me /myaccount in a private chat', '{admin}'),
    'Message me /myaccount in a private chat', '{admin}'),
    '/myaccount', 'the admin'),
    '/link', 'the admin')
  WHERE answer LIKE '%/myaccount%' OR answer LIKE '%/link%';

  UPDATE guides SET body_md = replace(replace(replace(replace(replace(body_md,
    'message the bot **/ticket** in a private chat', '{admin}'),
    'Message me /ticket', '{admin}'),
    'message me /ticket', '{admin}'),
    '/ticket', 'the admin'),
    '/myaccount', 'the admin')
  WHERE body_md LIKE '%/ticket%' OR body_md LIKE '%/myaccount%';

  UPDATE settings SET value = replace(replace(replace(replace(replace(value,
    'send /ticket in a private message to me and the team will help you out', '{admin} and they will help you out'),
    'message me /ticket', '{admin}'),
    'send me /ticket', '{admin}'),
    'message the admin here or send me /ticket', '{admin}'),
    '/ticket', 'the admin')
  WHERE value LIKE '%/ticket%';

  DELETE FROM settings WHERE key = 'reports.alertTickets';
  `,
  // v15 — semantic retrieval. faq_vectors caches one embedding per FAQ, keyed
  // by a hash of the text embedded so an edited FAQ re-embeds itself on next
  // use. answer_cache stores answers the model has already written, looked up
  // by meaning: the same twenty questions get asked forever in a support
  // group, and re-deriving an answer at a few tokens per second is the single
  // most wasteful thing the bot does.
  `
  CREATE TABLE faq_vectors (
    faq_id  INTEGER PRIMARY KEY,
    hash    TEXT NOT NULL,
    vector  BLOB NOT NULL,
    model   TEXT,
    ts      INTEGER NOT NULL
  );

  CREATE TABLE answer_cache (
    id          INTEGER PRIMARY KEY,
    question    TEXT NOT NULL,
    vector      BLOB NOT NULL,
    answer      TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'ai',
    hits        INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    last_hit_at INTEGER
  );
  CREATE INDEX idx_answer_cache_age ON answer_cache(created_at);
  `,
  // v16 — suggestions can now come from two very different places: questions
  // the bot FAILED on (it drafts the answer and leaves [ADMIN: fill this in]
  // gaps), and answers the admin actually gave in the group (the answer is
  // real, and the risk is the opposite — that it carries one person's codes,
  // dates or handle into an entry everyone would be shown). `source` says
  // which, `needs_review` carries why a draft wants a careful read.
  `
  ALTER TABLE suggested_faqs ADD COLUMN source TEXT NOT NULL DEFAULT 'unanswered';
  ALTER TABLE suggested_faqs ADD COLUMN needs_review TEXT;
  `,
  // v17 — the triage conversation ("you reported X, I gave you fixes, you said
  // it is still broken") lived in a plain Map in the bot process. The case row
  // in problem_reports survived a restart but the conversation did not, so
  // after every deploy a customer's "still not working" read as a brand new
  // problem: fixes they had already tried, round counting back to zero, and no
  // escalation. Timestamps are milliseconds here, matching Date.now() at the
  // call sites rather than the seconds used elsewhere.
  `
  CREATE TABLE problem_state (
    tg_user_id       INTEGER PRIMARY KEY,
    case_id          INTEGER,
    at               INTEGER NOT NULL,
    escalated_at     INTEGER,
    answered_at      INTEGER,
    nudged_at        INTEGER,
    awaiting_service INTEGER NOT NULL DEFAULT 0,
    from_auto_close  INTEGER NOT NULL DEFAULT 0,
    fix_rounds       INTEGER NOT NULL DEFAULT 0,
    first_text       TEXT,
    topic            TEXT
  );
  CREATE INDEX idx_problem_state_at ON problem_state(at);
  `,
  // v18 — lift the 220-token answer cap. v12 set it to protect slow CPU nodes
  // back when a call was non-streaming and all-or-nothing: a long answer blew
  // the whole timeout and the customer got nothing. Answers stream now and the
  // time budget returns partial text, so the cap no longer buys safety — it
  // just truncates install guides mid-step, which is the bit a customer
  // actually notices. Only raises values at or below the old default; a lower
  // number chosen deliberately for a slow node is not forced upwards past it.
  `
  UPDATE settings SET value = '500' WHERE key = 'ai.maxTokens' AND CAST(value AS INTEGER) <= 220;
  `,
  // v19 — the channel lineup, pulled from the service's own Xtream Codes API.
  // "What channel is the F1 on?" is a question about OUR lineup, so no public
  // sports API can answer it — only the panel the service actually runs on.
  // Cached because the list runs to thousands of rows and must never be sent
  // to the model wholesale; only the handful matching a question are.
  `
  CREATE TABLE xc_channels (
    id           INTEGER PRIMARY KEY,
    service      INTEGER NOT NULL,
    stream_id    INTEGER NOT NULL,
    name         TEXT NOT NULL,
    category     TEXT,
    epg_channel_id TEXT,
    updated_at   INTEGER NOT NULL,
    UNIQUE(service, stream_id)
  );
  CREATE INDEX idx_xc_channels_name ON xc_channels(service, name);
  `,
  // v20 — the guide, cached per channel. The lineup was already cached but
  // "what's on" went to the panel on every single question, so one customer
  // asking the same thing three times was three API calls, and a busy evening
  // hammered the panel for answers we already had.
  //
  // One row per channel holding the run of listings as JSON: nothing ever
  // queries inside them, they are read back whole and formatted into the
  // prompt, so rows-per-listing would buy nothing. last_end is the panel's own
  // epoch for the end of the cached run, which lets a finished run expire
  // early instead of waiting out the clock.
  `
  CREATE TABLE IF NOT EXISTS xc_epg (
    service    INTEGER NOT NULL,
    stream_id  INTEGER NOT NULL,
    listings   TEXT NOT NULL,
    last_end   INTEGER NOT NULL DEFAULT 0,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (service, stream_id)
  );
  `,
  // v21 — let a guide be upgraded the way an FAQ already can be.
  //
  // FAQs are refreshed when their text still matches a shipped default, which
  // needs every old default kept as a string. Guides are far too long for
  // that, so they were only ever replaced while they still carried the
  // "edit me first" marker — meaning a guide with real content was frozen
  // forever, however out of date it got. It matters more now: the bot sends
  // guides to customers, so a stale one is an answer, not a panel page.
  //
  // The hash of the text we seeded is recorded instead. Unchanged hash means
  // the admin never touched it, so it is safe to replace; anything else is
  // their work and is left alone. No old bodies to keep, and it covers every
  // future edit rather than just this one.
  `
  ALTER TABLE guides ADD COLUMN seed_hash TEXT;
  `,
  // v22 — the whole guide, not just the channels someone already named.
  //
  // get_short_epg answers "what's on Sky Sports Main Event?" because the
  // channel is in the question. It cannot answer "who's playing Derby
  // tonight?" or "what channel is the Arsenal game on?", where the channel is
  // the ANSWER: that needs searching programme titles across the lineup, and
  // the per-channel endpoint would mean one call per channel to do it.
  //
  // xmltv.php returns the lot in one download, joined to channels by the
  // epg_channel_id the lineup already stores. Only a window around now is
  // kept — these questions are about tonight and tomorrow, and holding a
  // week of listings for a few hundred channels makes the title scan slow
  // for no benefit.
  `
  CREATE TABLE IF NOT EXISTS xc_programmes (
    id         INTEGER PRIMARY KEY,
    service    INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    title      TEXT NOT NULL,
    start_ts   INTEGER NOT NULL,
    stop_ts    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_xc_prog_when ON xc_programmes(service, start_ts);
  CREATE INDEX IF NOT EXISTS idx_xc_prog_chan ON xc_programmes(service, channel_id, start_ts);
  `,
  // v23 — the VOD library, so "can we get Oppenheimer" can be checked against
  // what is actually on the service instead of being filed as a request for
  // something already there. That wastes the customer's evening (they wait for
  // a batch that will never come) and the admin's time (they close a request
  // for a title they already carry).
  //
  // Per service, because the two libraries are NOT the same — which is why
  // answering this at all means knowing which service the person is on.
  `
  CREATE TABLE IF NOT EXISTS xc_vod (
    id        INTEGER PRIMARY KEY,
    service   INTEGER NOT NULL,
    kind      TEXT NOT NULL,
    name      TEXT NOT NULL,
    norm_name TEXT NOT NULL,
    category  TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_xc_vod_norm ON xc_vod(service, norm_name);
  `,
  // v24 — the full guide downloads once a day rather than four times.
  // It is tens of megabytes and the listings it carries do not change often
  // enough to be worth that. Only moves a value still sitting on the old
  // default; a number the admin chose deliberately is left alone.
  `
  UPDATE settings SET value = '24' WHERE key = 'services.xmltvRefreshHours' AND value = '6';
  `,
  // v25 — per-channel listings are held for a day too. Safe because a cached
  // run already expires as soon as the panel's own stop timestamp says it has
  // finished; this value is the backstop for when it has not. A run the panel
  // gave no end time for is capped far shorter in code, whatever this says.
  // Only moves a value still sitting on the old default.
  `
  UPDATE settings SET value = '1440' WHERE key = 'services.epgCacheMinutes' AND value = '30';
  `,
  // v26 — somewhere to build the new guide without holding it in memory.
  //
  // The first cut collected every kept programme into a JS array and wrote it
  // in one transaction at the end. On a real panel (600 channels, a week of
  // listings) that peaked at 300MB RSS and stalled the event loop for a
  // second — so on a small container the process was OOM-killed, restarted,
  // downloaded again and was killed again. The bot looked dead because it
  // was, over and over.
  //
  // Rows now stream into here in small batches, and the swap into the live
  // table is one short transaction of pure SQL. Memory stays flat and the
  // readers still see either the old guide or the new one, never half of one.
  `
  CREATE TABLE IF NOT EXISTS xc_programmes_staging (
    id         INTEGER PRIMARY KEY,
    service    INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    title      TEXT NOT NULL,
    start_ts   INTEGER NOT NULL,
    stop_ts    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_xc_prog_stage ON xc_programmes_staging(service);
  `,
];

export function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
