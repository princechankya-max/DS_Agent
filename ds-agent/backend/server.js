import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import uploadRoutes from './routes/upload.js';
import analysisRoutes from './routes/analysis.js';
import billingRoutes from './routes/billing.js';
import workspaceRoutes from './routes/workspaces.js';
import { closeDB, getDB, initDB } from './db/database.js';
import {
  closeAnalysisQueue,
  checkAnalysisQueue,
  hasDurableAnalysisQueue,
  startAnalysisProgressSubscriber,
} from './services/analysisQueue.js';
import {
  checkObjectStorage,
  ensureObjectStorageBucket,
  isObjectStorageEnabled,
} from './services/storage.js';
import { hasSmtpConfiguration } from './services/email.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;
const appOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : undefined;
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
  : process.env.NODE_ENV === 'production'
    ? [appOrigin].filter(Boolean)
    : [appOrigin, 'http://localhost:5173', 'http://localhost:3001'].filter(Boolean);

if (
  !process.env.JWT_SECRET ||
  !process.env.JWT_REFRESH_SECRET ||
  process.env.JWT_SECRET.length < 32 ||
  process.env.JWT_REFRESH_SECRET.length < 32 ||
  process.env.JWT_SECRET === process.env.JWT_REFRESH_SECRET
) {
  if (process.env.NODE_ENV === 'production' || process.env.DEMO_MODE !== 'true') {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be distinct secrets of at least 32 characters');
  }
  process.env.JWT_SECRET ||= 'local-demo-access-secret-not-for-deployment';
  process.env.JWT_REFRESH_SECRET ||= 'local-demo-refresh-secret-not-for-deployment';
}
if (process.env.NODE_ENV === 'production') {
  if (!process.env.DATABASE_URL)
    throw new Error('DATABASE_URL must point to PostgreSQL in production');
  if (!hasDurableAnalysisQueue())
    throw new Error('REDIS_URL must point to a durable Redis service in production');
  if (!isObjectStorageEnabled())
    throw new Error('S3-compatible object storage settings must be configured in production');
  if (process.env.DEMO_MODE === 'true')
    throw new Error('DEMO_MODE must be disabled in production');
  if (!hasSmtpConfiguration())
    throw new Error('SMTP_HOST, SMTP_PORT, and SMTP_FROM must be configured in production');
  let appUrl;
  try {
    appUrl = new URL(process.env.APP_URL);
  } catch {
    throw new Error('APP_URL must be a valid HTTPS URL in production');
  }
  if (appUrl.protocol !== 'https:')
    throw new Error('APP_URL must use HTTPS in production');
}

// ── Socket.IO for real-time progress ──
export const io = new Server(httpServer, {
  cors: { origin: allowedOrigins }
});
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string') return next(new Error('Authentication required'));
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const database = getDB();
    const workspaceId = socket.handshake.auth?.workspaceId;
    const membership = await database.get(`SELECT wm.workspace_id FROM workspace_members wm
      JOIN users u ON u.id = wm.user_id
      WHERE wm.user_id = ? AND wm.workspace_id = ? AND u.email_verified = 1`,
    payload.userId, workspaceId);
    if (!membership) return next(new Error('Workspace access denied'));
    socket.data.userId = payload.userId;
    socket.data.workspaceId = membership.workspace_id;
    return next();
  } catch {
    return next(new Error('Invalid or expired socket credentials'));
  }
});
io.on('connection', socket => {
  socket.on('join-job', async jobId => {
    if (typeof jobId !== 'string' || jobId.length > 64)
      return socket.emit('job-access-denied', { error: 'Invalid analysis job' });
    try {
      const database = getDB();
      const analysis = await database.get('SELECT id FROM analyses WHERE id = ? AND workspace_id = ?',
        jobId, socket.data.workspaceId);
      if (!analysis) return socket.emit('job-access-denied', { error: 'Analysis not found in this workspace' });
      return socket.join(`job-${jobId}`);
    } catch (error) {
      console.error('Could not authorize analysis progress subscription:', error);
      return socket.emit('job-access-denied', { error: 'Could not authorize analysis progress' });
    }
  });
});

// ── Security Middleware ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate Limiting ──
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 100 : 10,
  message: { error: 'Too many attempts. Try after 15 minutes.' },
});
app.use('/api/auth', authLimiter);

// ── API Routes ──
app.use('/api/auth',     authRoutes);
app.use('/api/upload',   uploadRoutes);
app.use('/api/analysis', analysisRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/workspaces', workspaceRoutes);

// ── Health Check ──
app.get('/api/health', async (req, res) => {
  try {
    const database = getDB();
    await database.get('SELECT 1 AS ok');
    const [queue, storage] = await Promise.all([checkAnalysisQueue(), checkObjectStorage()]);
    return res.json({
      status: 'ok',
      name: 'DS Agent API',
      version: '1.0.0',
      dependencies: { database: 'ok', queue: queue.status, storage: storage.status },
    });
  } catch (error) {
    console.error('Health check dependency failed:', error);
    return res.status(503).json({ status: 'error', name: 'DS Agent API' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));

// ── Serve React in Production ──
if (process.env.NODE_ENV === 'production' || process.env.SERVE_FRONTEND === 'true') {
  app.use(express.static(path.join(__dirname, '../dist')));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../dist/index.html')));
}

// ── Init DB + Start ──
async function start() {
  await initDB();
  await ensureObjectStorageBucket();
  await startAnalysisProgressSubscriber(io);
  httpServer.listen(PORT, () => {
    console.log(`\n✦ DS Agent API  →  http://localhost:${PORT}`);
    console.log(`   Frontend Dev  →  http://localhost:5173`);
  });
}

start().catch(async error => {
  console.error('API startup failed:', error);
  await closeAnalysisQueue();
  await closeDB();
  process.exitCode = 1;
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down API`);
  httpServer.close(async error => {
    if (error) console.error('HTTP server shutdown failed:', error);
    await closeAnalysisQueue();
    await closeDB();
    process.exitCode = error ? 1 : 0;
  });
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
