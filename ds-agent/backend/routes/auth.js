import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../db/database.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'ds-agent-secret-change-in-production';
const JWT_REFRESH = process.env.JWT_REFRESH_SECRET || 'ds-agent-refresh-secret';

function makeTokens(userId) {
  const access  = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '15m' });
  const refresh = jwt.sign({ userId }, JWT_REFRESH, { expiresIn: '7d' });
  return { access, refresh };
}

// ── REGISTER ──
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'All fields required' });

    const pwRegex = /^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*]).{8,}$/;
    if (!pwRegex.test(password))
      return res.status(400).json({ error: 'Password must be 8+ chars with uppercase, number, special char' });

    const db = getDB();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const id = uuidv4();
    const hash = await bcrypt.hash(password, 12);
    const vToken = uuidv4();

    db.prepare(`INSERT INTO users (id, name, email, password_hash, verification_token) VALUES (?,?,?,?,?)`)
      .run(id, name.trim(), email.toLowerCase(), hash, vToken);

    // In production: send real email. For dev, return token directly.
    res.json({
      message: 'Account created! Check your email to verify.',
      dev_verification_token: vToken, // remove in production
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── VERIFY EMAIL ──
router.post('/verify-email', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const db = getDB();
  const user = db.prepare('SELECT id FROM users WHERE verification_token = ?').get(token);
  if (!user) return res.status(400).json({ error: 'Invalid or expired token' });

  db.prepare('UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?').run(user.id);
  res.json({ message: 'Email verified! You can now sign in.' });
});

// ── LOGIN ──
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const db = getDB();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase());

    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    // Check lockout
    if (user.locked_until && Date.now() < user.locked_until)
      return res.status(429).json({ error: `Account locked. Try after ${Math.ceil((user.locked_until - Date.now()) / 60000)} minutes.` });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const attempts = (user.failed_attempts || 0) + 1;
      const lockUntil = attempts >= 5 ? Date.now() + 15 * 60 * 1000 : null;
      db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
        .run(attempts, lockUntil, user.id);
      return res.status(401).json({ error: attempts >= 5 ? 'Account locked for 15 minutes' : 'Invalid email or password' });
    }

    // Reset failed attempts
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);

    const { access, refresh } = makeTokens(user.id);
    db.prepare('UPDATE users SET refresh_token = ? WHERE id = ?').run(refresh, user.id);

    res.json({
      access_token: access,
      user: { id: user.id, name: user.name, email: user.email, email_verified: user.email_verified }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── REFRESH TOKEN ──
router.post('/refresh', (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(401).json({ error: 'Refresh token required' });

  try {
    const payload = jwt.verify(refresh_token, JWT_REFRESH);
    const db = getDB();
    const user = db.prepare('SELECT id, refresh_token FROM users WHERE id = ?').get(payload.userId);
    if (!user || user.refresh_token !== refresh_token)
      return res.status(401).json({ error: 'Invalid refresh token' });

    const { access, refresh } = makeTokens(user.id);
    db.prepare('UPDATE users SET refresh_token = ? WHERE id = ?').run(refresh, user.id);
    res.json({ access_token: access, refresh_token: refresh });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// ── LOGOUT ──
router.post('/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      getDB().prepare('UPDATE users SET refresh_token = NULL WHERE id = ?').run(payload.userId);
    } catch {}
  }
  res.json({ message: 'Logged out' });
});

// ── FORGOT PASSWORD ──
router.post('/forgot-password', (req, res) => {
  const { email } = req.body;
  const db = getDB();
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email?.toLowerCase());
  if (user) {
    const resetToken = uuidv4();
    const expires = Date.now() + 60 * 60 * 1000; // 1 hour
    db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?')
      .run(resetToken, expires, user.id);
    // In prod: send email with reset link
    console.log(`[DEV] Password reset token: ${resetToken}`);
  }
  res.json({ message: 'If that email exists, a reset link has been sent.' });
});

// ── RESET PASSWORD ──
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  const db = getDB();
  const user = db.prepare('SELECT id, reset_token_expires FROM users WHERE reset_token = ?').get(token);
  if (!user || Date.now() > user.reset_token_expires)
    return res.status(400).json({ error: 'Invalid or expired reset link' });

  const hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?')
    .run(hash, user.id);
  res.json({ message: 'Password updated successfully' });
});

// ── GET ME ──
router.get('/me', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = getDB().prepare('SELECT id, name, email, email_verified, created_at FROM users WHERE id = ?').get(payload.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch { res.status(401).json({ error: 'Invalid token' }); }
});

export default router;
