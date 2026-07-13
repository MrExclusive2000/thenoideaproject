import Database from 'better-sqlite3';
import { config } from '../config.js';
import { migrate } from './schema.js';

export const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

migrate(db);

export function closeDb() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch {
    // already closed
  }
}

export const now = () => Math.floor(Date.now() / 1000);
