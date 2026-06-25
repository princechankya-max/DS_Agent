import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import nodemailer from 'nodemailer';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';

dotenv.config();
const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────
// DB SETUP
// ─────────────────────────────────────────────
const db = new Database('ds_agent.db');
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
    output_dir TEXT,
    progress INTEGER DEFAULT 0,
    error_msg TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    completed_at INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    name TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// Seed demo user
const demoExists = db.prepare('SELECT id FROM users WHERE email=?').get('demo@dsagent.ai');
if (!demoExists) {
  const hash = bcrypt.hashSync('Demo@12345', 12);
  db.prepare('INSERT INTO users (id,name,email,password_hash,email_verified) VALUES (?,?,?,?,1)')
    .run(uuidv4(), 'Demo User', 'demo@dsagent.ai', hash);
}

// ─────────────────────────────────────────────
// APP SETUP
// ─────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3001;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure dirs exist
['uploads','outputs'].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ─────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, message: { error: 'Too many attempts. Try again in 15 minutes.' } });
const apiLimiter  = rateLimit({ windowMs: 60*1000, max: 60 });
app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);

// ─────────────────────────────────────────────
// EMAIL (dev: ethereal / prod: env SMTP)
// ─────────────────────────────────────────────
let transporter;
(async () => {
  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT||587, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  } else {
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({ host:'smtp.ethereal.email', port:587, auth:{ user:testAccount.user, pass:testAccount.pass }});
    console.log('📧 Dev email preview:', nodemailer.getTestMessageUrl);
  }
})();

async function sendEmail(to, subject, html) {
  try {
    const info = await transporter.sendMail({ from:'"DS Agent" <noreply@dsagent.ai>', to, subject, html });
    if (process.env.NODE_ENV !== 'production') console.log('📧 Email preview:', nodemailer.getTestMessageUrl(info));
  } catch(e) { console.error('Email error:', e.message); }
}

// ─────────────────────────────────────────────
// AUTH HELPERS
// ─────────────────────────────────────────────
const JWT_SECRET  = process.env.JWT_SECRET || 'ds-agent-secret-change-in-prod-'+uuidv4();
const REFRESH_SECRET = process.env.REFRESH_SECRET || 'ds-refresh-'+uuidv4();

function signAccess(userId)  { return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '15m' }); }
function signRefresh(userId) { return jwt.sign({ userId }, REFRESH_SECRET, { expiresIn: '7d' }); }

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch(e) { return res.status(401).json({ error: 'Token expired or invalid' }); }
}

// ─────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────
// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name||!email||!password) return res.status(400).json({ error: 'All fields required' });
    const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRx.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    const pwRx = /^(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*]).{8,}$/;
    if (!pwRx.test(password)) return res.status(400).json({ error: 'Password must be 8+ chars with uppercase, number, and special character' });
    const exists = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (exists) return res.status(409).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    const token = uuidv4();
    db.prepare('INSERT INTO users (id,name,email,password_hash,verification_token) VALUES (?,?,?,?,?)').run(id,name,email,hash,token);
    const verifyUrl = `${process.env.APP_URL||'http://localhost:5173'}/verify-email?token=${token}`;
    await sendEmail(email,'Verify your DS Agent account',`<h2>Welcome to DS Agent, ${name}!</h2><p><a href="${verifyUrl}" style="background:#8B7CF8;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Verify Email</a></p><p>Link expires in 24 hours.</p>`);
    res.json({ message: 'Registration successful. Check your email to verify.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/verify-email
app.post('/api/auth/verify-email', (req, res) => {
  const { token } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE verification_token=?').get(token);
  if (!user) return res.status(400).json({ error: 'Invalid or expired verification token' });
  db.prepare('UPDATE users SET email_verified=1, verification_token=NULL WHERE id=?').run(user.id);
  const access = signAccess(user.id);
  const refresh = signRefresh(user.id);
  db.prepare('UPDATE users SET refresh_token=? WHERE id=?').run(refresh, user.id);
  res.json({ access, refresh, user: { id:user.id, name:user.name, email:user.email } });
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    // Lockout check
    if (user.locked_until && Date.now() < user.locked_until) return res.status(423).json({ error: 'Account locked. Try again later.' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const attempts = (user.failed_attempts||0)+1;
      const locked = attempts >= 5 ? Date.now()+15*60*1000 : null;
      db.prepare('UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?').run(attempts, locked, user.id);
      return res.status(401).json({ error: 'Invalid email or password', attemptsLeft: Math.max(0,5-attempts) });
    }
    if (!user.email_verified) return res.status(403).json({ error: 'Please verify your email first', needsVerification: true });
    db.prepare('UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?').run(user.id);
    const access = signAccess(user.id);
    const refresh = signRefresh(user.id);
    db.prepare('UPDATE users SET refresh_token=? WHERE id=?').run(refresh, user.id);
    res.json({ access, refresh, user: { id:user.id, name:user.name, email:user.email } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/refresh
app.post('/api/auth/refresh', (req, res) => {
  const { refresh } = req.body;
  if (!refresh) return res.status(401).json({ error: 'No refresh token' });
  try {
    const decoded = jwt.verify(refresh, REFRESH_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id=? AND refresh_token=?').get(decoded.userId, refresh);
    if (!user) return res.status(401).json({ error: 'Invalid refresh token' });
    const access = signAccess(user.id);
    const newRefresh = signRefresh(user.id);
    db.prepare('UPDATE users SET refresh_token=? WHERE id=?').run(newRefresh, user.id);
    res.json({ access, refresh: newRefresh });
  } catch(e) { res.status(401).json({ error: 'Refresh token expired' }); }
});

// POST /api/auth/logout
app.post('/api/auth/logout', authMiddleware, (req, res) => {
  db.prepare('UPDATE users SET refresh_token=NULL WHERE id=?').run(req.user.id);
  res.json({ message: 'Logged out' });
});

// POST /api/auth/forgot-password
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user) return res.json({ message: 'If this email exists, a reset link was sent.' });
  const token = uuidv4();
  const expires = Date.now() + 3600000; // 1 hour
  db.prepare('UPDATE users SET reset_token=?, reset_token_expires=? WHERE id=?').run(token, expires, user.id);
  const resetUrl = `${process.env.APP_URL||'http://localhost:5173'}/reset-password?token=${token}`;
  await sendEmail(email,'Reset your DS Agent password',`<h2>Password Reset</h2><p><a href="${resetUrl}" style="background:#8B7CF8;color:white;padding:12px 24px;border-radius:8px;text-decoration:none">Reset Password</a></p><p>Link expires in 1 hour.</p>`);
  res.json({ message: 'If this email exists, a reset link was sent.' });
});

// POST /api/auth/reset-password
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE reset_token=?').get(token);
  if (!user || user.reset_token_expires < Date.now()) return res.status(400).json({ error: 'Invalid or expired reset token' });
  const hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET password_hash=?, reset_token=NULL, reset_token_expires=NULL WHERE id=?').run(hash, user.id);
  res.json({ message: 'Password reset successfully' });
});

// GET /api/auth/me
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const { id, name, email, email_verified, created_at } = req.user;
  res.json({ id, name, email, email_verified, created_at });
});

// ─────────────────────────────────────────────
// FILE UPLOAD
// ─────────────────────────────────────────────
const MAGIC_BYTES = {
  csv:     null, // text detection
  xlsx:    Buffer.from([0x50,0x4B,0x03,0x04]),
  json:    null,
  parquet: Buffer.from([0x50,0x41,0x52,0x31]),
};
const ALLOWED_EXTS = ['csv','xlsx','json','parquet'];

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, `${uuidv4()}_${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 100*1024*1024 }, fileFilter: (req, file, cb) => {
  const ext = path.extname(file.originalname).slice(1).toLowerCase();
  if (!ALLOWED_EXTS.includes(ext)) return cb(new Error('Only CSV, XLSX, JSON, Parquet files allowed'));
  cb(null, true);
}});

function validateMagicBytes(filePath, ext) {
  const buf = fs.readFileSync(filePath);
  if (ext === 'xlsx') return buf.slice(0,4).equals(MAGIC_BYTES.xlsx);
  if (ext === 'parquet') return buf.slice(0,4).equals(MAGIC_BYTES.parquet);
  if (ext === 'json') { try { JSON.parse(buf.toString('utf8',0,Math.min(100,buf.length)).split('\n')[0]+'...'); return true; } catch{ return buf[0]===0x7B||buf[0]===0x5B; } }
  return true; // CSV is text, trust extension for now
}

app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
    if (!validateMagicBytes(req.file.path, ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'File content does not match extension (magic bytes invalid)' });
    }
    res.json({ fileId: req.file.filename, originalName: req.file.originalname, size: req.file.size, ext });
  } catch(e) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch{}
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// ANALYSIS JOB QUEUE
// ─────────────────────────────────────────────
const jobQueue = [];
let isWorkerRunning = false;

async function processJob(job) {
  const jobId = job.id;
  const outputDir = path.join('outputs', jobId);
  fs.mkdirSync(outputDir, { recursive: true });

  const update = (status, progress, extra={}) => {
    db.prepare('UPDATE analyses SET status=?, progress=?, result_json=?, completed_at=? WHERE id=?')
      .run(status, progress, extra.result ? JSON.stringify(extra.result) : null,
        status==='complete'||status==='failed' ? Math.floor(Date.now()/1000) : null, jobId);
    io.emit(`job:${jobId}`, { status, progress, ...extra });
  };

  try {
    update('running', 5);
    const config = { jobId, filePath: path.resolve(job.file_path), outputDir: path.resolve(outputDir), analysisType: job.analysis_type||'full', targetCol: job.target_col||null };
    fs.writeFileSync(path.join(outputDir,'job_config.json'), JSON.stringify(config));
    update('running', 15, { step: 'Profiling data...' });

    const result = await new Promise((resolve, reject) => {
      const py = execFile('python3', ['analysis_engine.py', '--config', path.join(outputDir,'job_config.json')], { timeout: 300000, maxBuffer: 10*1024*1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try { resolve(JSON.parse(stdout)); } catch{ reject(new Error('Invalid Python output')); }
      });
      // Stream progress from stderr
      py.stderr?.on('data', d => {
        const line = d.toString().trim();
        const match = line.match(/PROGRESS:(\d+):(.+)/);
        if (match) update('running', parseInt(match[1]), { step: match[2] });
      });
    });

    update('complete', 100, { result, step: 'Analysis complete!' });
  } catch(e) {
    db.prepare('UPDATE analyses SET status=?,error_msg=?,completed_at=? WHERE id=?').run('failed',e.message,Math.floor(Date.now()/1000),jobId);
    io.emit(`job:${jobId}`, { status:'failed', error: e.message });
  }
}

async function runWorker() {
  if (isWorkerRunning) return;
  isWorkerRunning = true;
  while (jobQueue.length > 0) {
    const job = jobQueue.shift();
    await processJob(job);
  }
  isWorkerRunning = false;
}

// ─────────────────────────────────────────────
// ANALYSIS ROUTES
// ─────────────────────────────────────────────
app.post('/api/analysis', authMiddleware, (req, res) => {
  try {
    const { fileId, name, analysisType, targetCol } = req.body;
    if (!fileId||!name) return res.status(400).json({ error: 'fileId and name required' });
    const filePath = path.join('uploads', fileId);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Uploaded file not found' });
    const id = uuidv4();
    const config = JSON.stringify({ fileId, analysisType: analysisType||'full', targetCol });
    db.prepare('INSERT INTO analyses (id,user_id,name,status,config_json,file_path) VALUES (?,?,?,?,?,?)')
      .run(id, req.user.id, name, 'queued', config, filePath);
    jobQueue.push({ id, file_path: filePath, analysis_type: analysisType||'full', target_col: targetCol });
    runWorker();
    res.json({ id, status:'queued' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analysis', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT id,name,status,progress,created_at,completed_at FROM analyses WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
  res.json(rows);
});

app.get('/api/analysis/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM analyses WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Analysis not found' });
  if (row.result_json) row.result = JSON.parse(row.result_json);
  res.json(row);
});

app.delete('/api/analysis/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM analyses WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try { if (row.output_dir && fs.existsSync(row.output_dir)) fs.rmSync(row.output_dir,{recursive:true}); } catch{}
  db.prepare('DELETE FROM analyses WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

app.get('/api/analysis/:id/download/:file', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM analyses WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const allowed = ['cleaned_data.csv','eda_report.md','insights_report.md','analysis_notebook.ipynb'];
  if (!allowed.includes(req.params.file)) return res.status(400).json({ error: 'Invalid file' });
  const filePath = path.join('outputs', req.params.id, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not generated yet' });
  res.download(filePath);
});

// Proxy Claude API (secure — keeps key server-side)
app.post('/api/claude', authMiddleware, async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const { default: fetch } = await import('node-fetch');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},
      body: JSON.stringify(req.body),
    });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname,'dist')));
  app.get('*', (req,res) => res.sendFile(path.join(__dirname,'dist','index.html')));
}

httpServer.listen(PORT, () => {
  console.log(`\n✦ DS Agent Server → http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('⚠  ANTHROPIC_API_KEY not set — AI features disabled');
  if (!process.env.JWT_SECRET) console.warn('⚠  JWT_SECRET not set — using random (sessions reset on restart)');
});
