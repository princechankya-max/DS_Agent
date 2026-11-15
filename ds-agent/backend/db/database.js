import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../ds_agent.db');
const usePostgres = Boolean(process.env.DATABASE_URL);
let db;
let pool;
let sqliteOperationTail = Promise.resolve();
const sqliteTransactionContext = new AsyncLocalStorage();

function serializeSqliteOperation(database, operation) {
  if (sqliteTransactionContext.getStore() === database)
    return Promise.resolve().then(operation);

  let release;
  const previous = sqliteOperationTail;
  sqliteOperationTail = new Promise(resolve => { release = resolve; });
  return previous.then(operation).finally(release);
}

function postgresSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`).replace(/\bunixepoch\(\)/g, "EXTRACT(EPOCH FROM NOW())::bigint");
}

function createPostgresAdapter(client) {
  return {
    async get(sql, ...params) {
      const result = await client.query(postgresSql(sql), params);
      return result.rows[0];
    },
    async all(sql, ...params) {
      const result = await client.query(postgresSql(sql), params);
      return result.rows;
    },
    async run(sql, ...params) {
      const result = await client.query(postgresSql(sql), params);
      return { changes: result.rowCount };
    },
    async lockWorkspace(workspaceId) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [workspaceId]);
    },
    async transaction(callback) {
      const connection = await pool.connect();
      const transactionDb = createPostgresAdapter(connection);
      try {
        await connection.query('BEGIN');
        const result = await callback(transactionDb);
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

function createSqliteAdapter(database) {
  return {
    database,
    async get(sql, ...params) {
      return serializeSqliteOperation(database, () => database.prepare(sql).get(...params));
    },
    async all(sql, ...params) {
      return serializeSqliteOperation(database, () => database.prepare(sql).all(...params));
    },
    async run(sql, ...params) {
      return serializeSqliteOperation(database, () => {
        const result = database.prepare(sql).run(...params);
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
      });
    },
    async transaction(callback) {
      if (sqliteTransactionContext.getStore() === database)
        throw new Error('Nested SQLite transactions are not supported');

      return serializeSqliteOperation(database, async () => {
        let transactionStarted = false;
        try {
          database.exec('BEGIN IMMEDIATE');
          transactionStarted = true;
          const result = await sqliteTransactionContext.run(database, () => callback(this));
          database.exec('COMMIT');
          transactionStarted = false;
          return result;
        } catch (error) {
          if (transactionStarted) database.exec('ROLLBACK');
          throw error;
        }
      });
    },
    async lockWorkspace() {},
  };
}

export function getDB() {
  if (!db) {
    if (usePostgres) {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
        max: Number(process.env.DATABASE_POOL_SIZE || 10),
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
      });
      db = createPostgresAdapter(pool);
    } else {
      const database = new Database(DB_PATH);
      database.pragma('foreign_keys = ON');
      db = createSqliteAdapter(database);
    }
  }
  return db;
}

async function createWorkspaceForUser(database, user) {
  const member = await database.get(
    'SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY created_at LIMIT 1',
    user.id,
  );
  if (member) return member.workspace_id;

  const workspaceId = `personal-${user.id}`;
  const slug = `personal-${String(user.id).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40).toLowerCase()}`;
  await database.run(
    'INSERT INTO workspaces (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
    workspaceId,
    `${user.name || 'Personal'} workspace`,
    slug,
    user.id,
  );
  await database.run(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES (?, ?, 'owner') ON CONFLICT(workspace_id, user_id) DO NOTHING`,
    workspaceId,
    user.id,
  );
  return workspaceId;
}

async function migratePostgres(database) {
  await database.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      email_verified INTEGER DEFAULT 0, verification_token TEXT, verification_token_expires BIGINT,
      reset_token TEXT, reset_token_expires BIGINT, refresh_token TEXT,
      failed_attempts INTEGER DEFAULT 0, locked_until BIGINT,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
    )`);
  await database.run(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id), created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
    )`);
  await database.run(`
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
      PRIMARY KEY (workspace_id, user_id)
    )`);
  await database.run(`
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, status TEXT DEFAULT 'queued',
      config_json TEXT, result_json TEXT, file_path TEXT, original_name TEXT, file_size BIGINT,
      output_dir TEXT, error_msg TEXT, created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
      completed_at BIGINT
    )`);
  await database.run('ALTER TABLE analyses ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id)');
  await database.run(`
    CREATE TABLE IF NOT EXISTS uploaded_files (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      user_id TEXT NOT NULL REFERENCES users(id), object_key TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL, file_size BIGINT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
    )`);
  await database.run(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), key_hash TEXT NOT NULL,
      name TEXT, created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint), last_used BIGINT
    )`);
  await database.run(`
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      user_id TEXT PRIMARY KEY REFERENCES users(id), razorpay_subscription_id TEXT UNIQUE,
      plan_code TEXT NOT NULL, status TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1,
      current_start BIGINT, current_end BIGINT, cancel_at_cycle_end INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
      updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
    )`);
  await database.run(`
    CREATE TABLE IF NOT EXISTS workspace_subscriptions (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      razorpay_subscription_id TEXT UNIQUE, plan_code TEXT NOT NULL, status TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1, current_start BIGINT, current_end BIGINT,
      cancel_at_cycle_end INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
      updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
    )`);
  await database.run(`
    CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
      event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
    )`);
  await database.run(`
    CREATE TABLE IF NOT EXISTS workspace_invitations (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','member')),
      token_hash TEXT UNIQUE NOT NULL, expires_at BIGINT NOT NULL, accepted_at BIGINT,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
      UNIQUE (workspace_id, email)
    )`);
  await database.run('CREATE INDEX IF NOT EXISTS analyses_workspace_created_idx ON analyses(workspace_id, created_at DESC)');
  await database.run('CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id, created_at)');
  await database.run('CREATE INDEX IF NOT EXISTS uploaded_files_workspace_idx ON uploaded_files(workspace_id, created_at DESC)');
  await database.run(`
    UPDATE analyses a SET workspace_id = (
      SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = a.user_id ORDER BY wm.created_at LIMIT 1
    ) WHERE workspace_id IS NULL`);
}

async function migrateSqlite(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      email_verified INTEGER DEFAULT 0, verification_token TEXT, verification_token_expires INTEGER,
      reset_token TEXT, reset_token_expires INTEGER, refresh_token TEXT,
      failed_attempts INTEGER DEFAULT 0, locked_until INTEGER, created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, owner_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), FOREIGN KEY (owner_user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (workspace_id, user_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id), FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY, workspace_id TEXT, user_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT DEFAULT 'queued',
      config_json TEXT, result_json TEXT, file_path TEXT, original_name TEXT, file_size INTEGER,
      output_dir TEXT, error_msg TEXT, created_at INTEGER DEFAULT (unixepoch()), completed_at INTEGER,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id), FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS uploaded_files (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
      object_key TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL, file_size INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key_hash TEXT NOT NULL, name TEXT,
      created_at INTEGER DEFAULT (unixepoch()), last_used INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      user_id TEXT PRIMARY KEY, razorpay_subscription_id TEXT UNIQUE, plan_code TEXT NOT NULL, status TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1, current_start INTEGER, current_end INTEGER,
      cancel_at_cycle_end INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()), FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS workspace_subscriptions (
      workspace_id TEXT PRIMARY KEY, razorpay_subscription_id TEXT UNIQUE, plan_code TEXT NOT NULL, status TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1, current_start INTEGER, current_end INTEGER,
      cancel_at_cycle_end INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
      event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS workspace_invitations (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','member')), token_hash TEXT UNIQUE NOT NULL,
      expires_at INTEGER NOT NULL, accepted_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE (workspace_id, email),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id, created_at);
    CREATE INDEX IF NOT EXISTS uploaded_files_workspace_idx ON uploaded_files(workspace_id, created_at DESC);
  `);
  const columns = new Set(database.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  if (!columns.has('verification_token_expires'))
    database.exec('ALTER TABLE users ADD COLUMN verification_token_expires INTEGER');
  const analysisColumns = new Set(database.prepare('PRAGMA table_info(analyses)').all().map(column => column.name));
  if (!analysisColumns.has('workspace_id')) database.exec('ALTER TABLE analyses ADD COLUMN workspace_id TEXT');
  database.exec('CREATE INDEX IF NOT EXISTS analyses_workspace_created_idx ON analyses(workspace_id, created_at DESC)');
}

export async function initDB() {
  const database = getDB();
  if (usePostgres) await migratePostgres(database);
  else await migrateSqlite(database.database);

  if (process.env.NODE_ENV !== 'production' || process.env.DEMO_MODE === 'true') {
    const existing = await database.get('SELECT id FROM users WHERE email = ?', 'demo@dsagent.ai');
    if (!existing) {
      const hash = await bcrypt.hash('Demo@12345', 12);
      await database.run(
        'INSERT INTO users (id, name, email, password_hash, email_verified) VALUES (?, ?, ?, ?, 1)',
        'demo-user-id',
        'Demo User',
        'demo@dsagent.ai',
        hash,
      );
    }
  }

  const users = await database.all('SELECT id, name FROM users');
  for (const user of users) await createWorkspaceForUser(database, user);
  await database.run(`
    UPDATE analyses SET workspace_id = (
      SELECT workspace_id FROM workspace_members WHERE workspace_members.user_id = analyses.user_id
      ORDER BY created_at LIMIT 1
    ) WHERE workspace_id IS NULL`);
  await database.run(`
    INSERT INTO workspace_subscriptions
      (workspace_id, razorpay_subscription_id, plan_code, status, quantity, current_start, current_end,
       cancel_at_cycle_end, created_at, updated_at)
    SELECT wm.workspace_id, bs.razorpay_subscription_id, bs.plan_code, bs.status, bs.quantity,
           bs.current_start, bs.current_end, bs.cancel_at_cycle_end, bs.created_at, bs.updated_at
    FROM billing_subscriptions bs
    JOIN workspace_members wm ON wm.user_id = bs.user_id
    WHERE 1 = 1
    ON CONFLICT (workspace_id) DO NOTHING`);
  if (usePostgres) await database.run('ALTER TABLE analyses ALTER COLUMN workspace_id SET NOT NULL');

  console.log(`✓ Database initialized (${usePostgres ? 'PostgreSQL' : 'SQLite local fallback'})`);
}

export async function closeDB() {
  if (pool) await pool.end();
  else if (db) {
    const database = db;
    db = null;
    database.database?.close();
  }
  db = null;
  pool = null;
  sqliteOperationTail = Promise.resolve();
}
