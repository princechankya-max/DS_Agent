import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('SQLite fallback enforces declared workspace relationships', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-agent-database-test-'));
  const environment = {
    DB_PATH: process.env.DB_PATH,
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    DEMO_MODE: process.env.DEMO_MODE,
  };
  process.env.DB_PATH = path.join(directory, 'test.sqlite');
  process.env.DATABASE_URL = '';
  process.env.NODE_ENV = 'test';
  process.env.DEMO_MODE = 'false';
  let closeDatabase;

  try {
    const databaseModule = await import('../backend/db/database.js');
    closeDatabase = databaseModule.closeDB;
    const { getDB, initDB } = databaseModule;
    await initDB();
    const db = getDB();

    assert.equal(db.database.pragma('foreign_keys', { simple: true }), 1);
    await assert.rejects(
      db.run(`INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES ('missing-workspace', 'missing-user', 'member')`),
      /FOREIGN KEY constraint failed/,
    );
    await assert.rejects(
      db.run(`INSERT INTO uploaded_files
        (id, workspace_id, user_id, object_key, original_name, file_size)
        VALUES ('file-1', 'missing-workspace', 'missing-user', 'key-1', 'file.csv', 1)`),
      /FOREIGN KEY constraint failed/,
    );
    await assert.rejects(
      db.run(`INSERT INTO workspace_subscriptions (workspace_id, plan_code, status)
        VALUES ('missing-workspace', 'pro', 'active')`),
      /FOREIGN KEY constraint failed/,
    );
    await assert.rejects(
      db.run(`INSERT INTO workspace_invitations
        (id, workspace_id, email, role, token_hash, expires_at)
        VALUES ('invitation-1', 'missing-workspace', 'member@example.com', 'member', 'token', 1)`),
      /FOREIGN KEY constraint failed/,
    );

    await db.run('CREATE TABLE transaction_isolation_test (source TEXT NOT NULL)');
    let releaseTransaction;
    let transactionStarted;
    const started = new Promise(resolve => { transactionStarted = resolve; });
    const holdTransaction = new Promise(resolve => { releaseTransaction = resolve; });
    const transaction = db.transaction(async transactionDb => {
      await transactionDb.run('INSERT INTO transaction_isolation_test (source) VALUES (?)', 'transaction');
      transactionStarted();
      await holdTransaction;
      throw new Error('rollback transaction');
    });
    await started;

    let externalWriteFinished = false;
    const externalWrite = db.run(
      'INSERT INTO transaction_isolation_test (source) VALUES (?)',
      'external',
    ).then(() => { externalWriteFinished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(externalWriteFinished, false, 'external writes must wait for the transaction');

    releaseTransaction();
    await assert.rejects(transaction, /rollback transaction/);
    await externalWrite;
    assert.deepEqual(
      await db.all('SELECT source FROM transaction_isolation_test'),
      [{ source: 'external' }],
    );
  } finally {
    if (closeDatabase) await closeDatabase();
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
