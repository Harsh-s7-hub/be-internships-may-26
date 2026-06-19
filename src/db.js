import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = process.env.DATABASE_URL || './data/signals.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

// schema
db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_created ON signals(user_id, created_at);
`);

// failure simulation
function maybeFail() {
  const rate = Number(process.env.DB_FAIL_RATE || 0);
  if (rate > 0 && Math.random() < rate) {
    const err = new Error('simulated_db_failure');
    err.code = 'SQLITE_BUSY';
    throw err;
  }
}


async function withRetry(fn, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries - 1) {
        // exponential backoff with jitter: 50ms, 100ms, 200ms + jitter
        const delay = (Math.pow(2, attempt) * 50) + Math.random() * 20;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

export async function insertSignal(userId, type, payload, idemKey, nowMs) {
  return withRetry(() => {
    maybeFail();
    const stmt = db.prepare(
      'INSERT INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?,?,?,?,?)'
    );
    return stmt.run(userId, type, String(payload), idemKey || null, nowMs);
  });
}

export async function getByIdemKey(idemKey) {
  return withRetry(() => {
    maybeFail();
    const stmt = db.prepare(
      'SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE idempotency_key = ?'
    );
    return stmt.get(idemKey);
  });
}

export async function listSignals(userId, limit) {
  return withRetry(() => {
    maybeFail();
    const stmt = db.prepare(
      'SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    );
    return stmt.all(userId, limit);
  });
}
