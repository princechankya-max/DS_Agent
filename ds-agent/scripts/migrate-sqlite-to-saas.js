import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { closeDB, getDB, initDB } from '../backend/db/database.js';
import { closeAnalysisQueue, enqueueAnalysis, hasDurableAnalysisQueue } from '../backend/services/analysisQueue.js';
import {
  getWorkspaceAnalysisPrefix,
  getWorkspaceUploadKey,
  ensureObjectStorageBucket,
  isObjectStorageEnabled,
  storeFile,
  uploadDirectory,
} from '../backend/services/storage.js';

const sourcePath = path.resolve(process.env.MIGRATION_SQLITE_PATH || process.env.DB_PATH || 'ds_agent.db');
const sourceUploadsRoot = path.resolve(process.env.MIGRATION_UPLOADS_DIR || process.env.UPLOADS_DIR || 'uploads');
const sourceOutputsRoot = path.resolve(process.env.MIGRATION_OUTPUTS_DIR || process.env.OUTPUTS_DIR || 'outputs');

function hasTable(source, table) {
  return Boolean(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columnsFor(source, table) {
  if (!hasTable(source, table)) return new Set();
  return new Set(source.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

function value(row, columns, name, fallback = null) {
  return columns.has(name) ? row[name] : fallback;
}

function safeLocalFile(inputPath, root) {
  const resolved = path.resolve(inputPath);
  if (!resolved.startsWith(`${root}${path.sep}`))
    throw new Error('A source upload is outside the configured uploads directory');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())
    throw new Error('A source upload is missing; migration stopped without deleting source data');
  const realPath = fs.realpathSync(resolved);
  const realRoot = fs.realpathSync(root);
  if (!realPath.startsWith(`${realRoot}${path.sep}`))
    throw new Error('A source upload resolves outside the configured uploads directory');
  return realPath;
}

function safeLocalDirectory(inputPath, root) {
  const resolved = path.resolve(inputPath);
  if (!resolved.startsWith(`${root}${path.sep}`))
    throw new Error('An analysis output is outside the configured outputs directory');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
    throw new Error('An analysis output directory is missing; migration stopped without deleting source data');
  const realPath = fs.realpathSync(resolved);
  const realRoot = fs.realpathSync(root);
  if (!realPath.startsWith(`${realRoot}${path.sep}`))
    throw new Error('An analysis output resolves outside the configured outputs directory');
  return realPath;
}

async function copyStoredUpload(database, sourceKey, workspaceId, userId, originalName, fileSize, fileId) {
  if (typeof sourceKey !== 'string' || !sourceKey)
    throw new Error('A source upload has no stored path');
  const localPath = safeLocalFile(sourceKey, sourceUploadsRoot);
  const id = fileId || uuidv4();
  const destinationKey = getWorkspaceUploadKey(workspaceId, id, originalName || path.basename(localPath));
  await storeFile(localPath, destinationKey);
  await database.run(`INSERT INTO uploaded_files
    (id, workspace_id, user_id, object_key, original_name, file_size)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING`,
  id,
  workspaceId,
  userId,
  destinationKey,
  originalName || path.basename(localPath),
  Number(fileSize || fs.statSync(localPath).size));
  return destinationKey;
}

async function main() {
  if (!process.env.DATABASE_URL)
    throw new Error('Set DATABASE_URL to the destination PostgreSQL database before running this migration');
  if (!process.env.REDIS_URL || !hasDurableAnalysisQueue())
    throw new Error('Set REDIS_URL and start the destination Redis service before migrating queued analyses');
  if (!isObjectStorageEnabled())
    throw new Error('Configure S3-compatible object storage before migrating uploads and analysis outputs');
  if (!fs.existsSync(sourcePath)) throw new Error('SQLite source database does not exist');
  const sqlite = new Database(sourcePath, { readonly: true, fileMustExist: true });

  process.env.NODE_ENV = 'production';
  process.env.DEMO_MODE = 'false';
  await initDB();
  await ensureObjectStorageBucket();
  const destination = getDB();
  const fileKeyMap = new Map();
  const workspaceByUser = new Map();
  let userCount = 0;
  let workspaceCount = 0;
  let uploadCount = 0;
  let analysisCount = 0;

  try {
    if (!hasTable(sqlite, 'users')) throw new Error('SQLite source has no users table');
    const userColumns = columnsFor(sqlite, 'users');
    const users = sqlite.prepare('SELECT * FROM users').all();
    for (const user of users) {
      await destination.run(`INSERT INTO users
        (id, name, email, password_hash, email_verified, verification_token, verification_token_expires,
         reset_token, reset_token_expires, refresh_token, failed_attempts, locked_until, created_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`,
      user.id, user.name, user.email, user.password_hash, user.email_verified || 0,
      user.failed_attempts || 0, value(user, userColumns, 'locked_until'), user.created_at || 0);
      const emailOwner = await destination.get('SELECT id FROM users WHERE email = ?', user.email);
      if (emailOwner?.id !== user.id)
        throw new Error('A destination account already uses an email from the SQLite source');
      userCount += 1;
    }

    const sourceWorkspaces = hasTable(sqlite, 'workspaces')
      ? sqlite.prepare('SELECT * FROM workspaces').all()
      : [];
    for (const workspace of sourceWorkspaces) {
      await destination.run(`INSERT INTO workspaces (id, name, slug, owner_user_id, created_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      workspace.id, workspace.name, workspace.slug, workspace.owner_user_id, workspace.created_at || 0);
      workspaceCount += 1;
    }
    if (hasTable(sqlite, 'workspace_members')) {
      const members = sqlite.prepare('SELECT * FROM workspace_members').all();
      for (const member of members) {
        await destination.run(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, user_id) DO NOTHING`,
        member.workspace_id, member.user_id, member.role, member.created_at || 0);
        workspaceByUser.set(member.user_id, member.workspace_id);
      }
    }

    for (const user of users) {
      if (!workspaceByUser.has(user.id)) {
        const workspaceId = `personal-${String(user.id).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40).toLowerCase()}`;
        const slug = `personal-${String(user.id).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40).toLowerCase()}`;
        await destination.run(`INSERT INTO workspaces (id, name, slug, owner_user_id, created_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        workspaceId, `${user.name || 'Personal'} workspace`, slug, user.id, user.created_at || 0);
        await destination.run(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
          VALUES (?, ?, 'owner', ?) ON CONFLICT(workspace_id, user_id) DO NOTHING`,
        workspaceId, user.id, user.created_at || 0);
        workspaceByUser.set(user.id, workspaceId);
        workspaceCount += 1;
      }
    }

    if (hasTable(sqlite, 'uploaded_files')) {
      const fileColumns = columnsFor(sqlite, 'uploaded_files');
      for (const file of sqlite.prepare('SELECT * FROM uploaded_files').all()) {
        const workspaceId = value(file, fileColumns, 'workspace_id') || workspaceByUser.get(file.user_id);
        if (!workspaceId) throw new Error('An uploaded file does not map to a source workspace');
        const key = await copyStoredUpload(
          destination,
          file.object_key,
          workspaceId,
          file.user_id,
          file.original_name,
          file.file_size,
          file.id,
        );
        fileKeyMap.set(file.object_key, key);
        uploadCount += 1;
      }
    }

    if (hasTable(sqlite, 'analyses')) {
      const analysisColumns = columnsFor(sqlite, 'analyses');
      for (const analysis of sqlite.prepare('SELECT * FROM analyses').all()) {
        if (await destination.get('SELECT id FROM analyses WHERE id = ?', analysis.id)) continue;
        const workspaceId = value(analysis, analysisColumns, 'workspace_id') || workspaceByUser.get(analysis.user_id);
        if (!workspaceId) throw new Error('An analysis does not map to a source workspace');
        let fileKey = value(analysis, analysisColumns, 'file_path');
        if (fileKey && !fileKeyMap.has(fileKey)) {
          fileKey = await copyStoredUpload(
            destination,
            fileKey,
            workspaceId,
            analysis.user_id,
            value(analysis, analysisColumns, 'original_name'),
            value(analysis, analysisColumns, 'file_size'),
          );
          fileKeyMap.set(value(analysis, analysisColumns, 'file_path'), fileKey);
          uploadCount += 1;
        } else if (fileKey) {
          fileKey = fileKeyMap.get(fileKey);
        }

        let outputKey = value(analysis, analysisColumns, 'output_dir');
        if (outputKey) {
          const outputRoot = safeLocalDirectory(outputKey, sourceOutputsRoot);
          const destinationPrefix = getWorkspaceAnalysisPrefix(workspaceId, analysis.id);
          await uploadDirectory(outputRoot, destinationPrefix);
          outputKey = destinationPrefix;
        }

        await destination.run(`INSERT INTO analyses
          (id, workspace_id, user_id, name, status, config_json, result_json, file_path, original_name,
           file_size, output_dir, error_msg, created_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        analysis.id,
        workspaceId,
        analysis.user_id,
        analysis.name,
        ['queued', 'running'].includes(analysis.status) ? 'queued' : analysis.status,
        value(analysis, analysisColumns, 'config_json'),
        value(analysis, analysisColumns, 'result_json'),
        fileKey,
        value(analysis, analysisColumns, 'original_name'),
        value(analysis, analysisColumns, 'file_size'),
        outputKey,
        value(analysis, analysisColumns, 'error_msg'),
        analysis.created_at || 0,
        value(analysis, analysisColumns, 'completed_at'));
        analysisCount += 1;
      }
    }

    if (hasTable(sqlite, 'billing_subscriptions')) {
      for (const subscription of sqlite.prepare('SELECT * FROM billing_subscriptions').all()) {
        const workspaceId = workspaceByUser.get(subscription.user_id);
        if (!workspaceId) continue;
        await destination.run(`INSERT INTO workspace_subscriptions
          (workspace_id, razorpay_subscription_id, plan_code, status, quantity, current_start, current_end,
           cancel_at_cycle_end, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id) DO NOTHING`,
        workspaceId, subscription.razorpay_subscription_id, subscription.plan_code, subscription.status,
        subscription.quantity || 1, subscription.current_start, subscription.current_end,
        subscription.cancel_at_cycle_end || 0, subscription.created_at || 0, subscription.updated_at || 0);
      }
    }

    if (hasTable(sqlite, 'api_keys')) {
      for (const key of sqlite.prepare('SELECT * FROM api_keys').all()) {
        await destination.run(`INSERT INTO api_keys (id, user_id, key_hash, name, created_at, last_used)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        key.id, key.user_id, key.key_hash, key.name, key.created_at || 0, key.last_used);
      }
    }

    if (hasTable(sqlite, 'workspace_invitations')) {
      for (const invitation of sqlite.prepare('SELECT * FROM workspace_invitations').all()) {
        await destination.run(`INSERT INTO workspace_invitations
          (id, workspace_id, email, role, token_hash, expires_at, accepted_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        invitation.id,
        invitation.workspace_id,
        invitation.email,
        invitation.role,
        invitation.token_hash,
        invitation.expires_at,
        invitation.accepted_at,
        invitation.created_at || 0);
      }
    }

    if (hasTable(sqlite, 'razorpay_webhook_events')) {
      for (const event of sqlite.prepare('SELECT * FROM razorpay_webhook_events').all()) {
        await destination.run(`INSERT INTO razorpay_webhook_events (event_id, event_type, created_at)
          VALUES (?, ?, ?) ON CONFLICT(event_id) DO NOTHING`,
        event.event_id, event.event_type, event.created_at || 0);
      }
    }

    const queued = await destination.all("SELECT id FROM analyses WHERE status = 'queued'");
    for (const analysis of queued) await enqueueAnalysis(analysis.id);

    console.log(`Migration complete: ${userCount} users, ${workspaceCount} workspaces, ${uploadCount} uploads, ${analysisCount} analyses.`);
    console.log(`Queued ${queued.length} pending analyses. The SQLite source database and files were not deleted. Require users to sign in again after migration.`);
  } finally {
    sqlite.close();
    await closeAnalysisQueue();
    await closeDB();
  }
}

main().catch(error => {
  console.error('SQLite-to-SaaS migration failed:', error.message);
  process.exitCode = 1;
});
