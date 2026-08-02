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
