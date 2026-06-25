import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server } from 'socket.io';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import uploadRoutes from './routes/upload.js';
import analysisRoutes from './routes/analysis.js';
import { initDB } from './db/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;

// ── Socket.IO for real-time progress ──
export const io = new Server(httpServer, {
  cors: { origin: ['http://localhost:5173', 'http://localhost:3001'] }
});
io.on('connection', (socket) => {
  socket.on('join-job', (jobId) => socket.join(`job-${jobId}`));
});

// ── Security Middleware ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:3001'], credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate Limiting ──
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many attempts. Try after 15 minutes.' } });
app.use('/api/auth', authLimiter);

// ── Static Files ──
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/outputs', express.static(path.join(__dirname, '../outputs')));

// ── API Routes ──
app.use('/api/auth',     authRoutes);
app.use('/api/upload',   uploadRoutes);
app.use('/api/analysis', analysisRoutes);

// ── Health Check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: 'DS Agent API', version: '1.0.0' });
});

// ── Serve React in Production ──
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../dist/index.html')));
}

// ── Init DB + Start ──
initDB();
httpServer.listen(PORT, () => {
  console.log(`\n✦ DS Agent API  →  http://localhost:${PORT}`);
  console.log(`   Frontend Dev  →  http://localhost:5173`);
  if (!process.env.JWT_SECRET) console.warn('\n⚠️  JWT_SECRET not set in .env!\n');
});
