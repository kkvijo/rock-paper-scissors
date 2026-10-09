/* =========================================================
   Database — SQLite via Node's built-in node:sqlite
   ========================================================= */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DB_PATH || path.join(rootDir, 'data', 'dojo.db');
mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    rating        INTEGER NOT NULL DEFAULT 1000,
    wins          INTEGER NOT NULL DEFAULT 0,
    losses        INTEGER NOT NULL DEFAULT 0,
    draws         INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS matches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    p1_id         INTEGER NOT NULL REFERENCES users(id),
    p2_id         INTEGER NOT NULL REFERENCES users(id),
    winner_id     INTEGER REFERENCES users(id),
    p1_score      INTEGER NOT NULL,
    p2_score      INTEGER NOT NULL,
    p1_delta      INTEGER NOT NULL,
    p2_delta      INTEGER NOT NULL,
    rounds        TEXT NOT NULL,
    end_reason    TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_matches_p1 ON matches(p1_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_matches_p2 ON matches(p2_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_users_rating ON users(rating DESC);
`);

// Clear out expired sessions on boot.
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

/** Run fn inside a transaction; rolls back if it throws. */
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Public-facing shape of a user row (never includes the password hash). */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    rating: row.rating,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    createdAt: row.created_at
  };
}
