import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../../ds_agent.db');

let db;

export function getDB() {
  if (!db) db = new Database(DB_PATH);
  return db;
}

export function initDB() {
  const db = getDB();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email_verified INTEGER DEFAULT 0,
      verification_token TEXT,
      reset_token TEXT,
      reset_token_expires INTEGER,
      refresh_token TEXT,
      failed_attempts INTEGER DEFAULT 0,
      locked_until INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'queued',
      config_json TEXT,
      result_json TEXT,
      file_path TEXT,
      original_name TEXT,
      file_size INTEGER,
      output_dir TEXT,
      error_msg TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      completed_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      name TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      last_used INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // Seed demo user
  const demo = db.prepare('SELECT id FROM users WHERE email = ?').get('demo@dsagent.ai');
  if (!demo) {
    import('bcryptjs').then(({ default: bcrypt }) => {
      const hash = bcrypt.hashSync('Demo@12345', 12);
      const { v4: uuidv4 } = require('uuid');
      db.prepare(`INSERT INTO users (id, name, email, password_hash, email_verified) VALUES (?,?,?,?,1)`)
        .run('demo-user-id', 'Demo User', 'demo@dsagent.ai', hash);
    }).catch(() => {});
  }

  console.log('✓ Database initialized');
}
