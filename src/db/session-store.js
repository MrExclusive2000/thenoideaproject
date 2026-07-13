import { Store } from 'express-session';

// Minimal express-session store on better-sqlite3 — single-process app, so a
// synchronous store is fine and avoids another dependency.
export class SqliteSessionStore extends Store {
  constructor(db, { ttlSeconds = 60 * 60 * 24 * 7 } = {}) {
    super();
    this.db = db;
    this.ttlSeconds = ttlSeconds;
    this.getStmt = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expire > ?');
    this.setStmt = db.prepare(
      'INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?) ' +
      'ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire'
    );
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?');
    this.pruneStmt = db.prepare('DELETE FROM sessions WHERE expire <= ?');
    this.pruneTimer = setInterval(() => this.prune(), 10 * 60 * 1000);
    this.pruneTimer.unref();
  }

  #expiry(sess) {
    if (sess?.cookie?.expires) return Math.floor(new Date(sess.cookie.expires).getTime() / 1000);
    return Math.floor(Date.now() / 1000) + this.ttlSeconds;
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid, Math.floor(Date.now() / 1000));
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), this.#expiry(sess));
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.destroyStmt.run(sid);
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      this.touchStmt.run(this.#expiry(sess), sid);
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  prune() {
    try {
      this.pruneStmt.run(Math.floor(Date.now() / 1000));
    } catch {
      // best effort
    }
  }
}
