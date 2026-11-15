import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../db/database.js';
import { createOneTimeToken, hashOneTimeToken } from '../security/oneTimeTokens.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../services/email.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH = process.env.JWT_REFRESH_SECRET;
const PASSWORD_PATTERN = /^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*]).{8,}$/;

function makeTokens(userId) {
  const access = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '15m' });
  const refresh = jwt.sign({ userId }, JWT_REFRESH, { expiresIn: '7d', jwtid: uuidv4() });
  return { access, refresh };
}

function isDuplicateError(error) {
  return error.code === '23505' || String(error.code || '').startsWith('SQLITE_CONSTRAINT');
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string')
      return res.status(400).json({ error: 'All fields required' });

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 100 || normalizedEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
      return res.status(400).json({ error: 'Enter a valid name and email address' });
    if (!PASSWORD_PATTERN.test(password))
      return res.status(400).json({ error: 'Password must be 8+ chars with uppercase, number, special char' });

    const db = getDB();
    if (await db.get('SELECT id FROM users WHERE email = ?', normalizedEmail))
      return res.status(409).json({ error: 'Email already registered' });

    const id = uuidv4();
    const workspaceId = uuidv4();
    const hash = await bcrypt.hash(password, 12);
    const verification = createOneTimeToken();
    try {
      await db.transaction(async transaction => {
        await transaction.run(`INSERT INTO users
          (id, name, email, password_hash, verification_token, verification_token_expires)
          VALUES (?, ?, ?, ?, ?, ?)`,
        id, normalizedName, normalizedEmail, hash, verification.tokenHash, Date.now() + 86400000);
        await transaction.run('INSERT INTO workspaces (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)',
          workspaceId, `${normalizedName}'s workspace`, `workspace-${workspaceId}`, id);
        await transaction.run(
          "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')",
          workspaceId,
          id,
        );
      });
    } catch (error) {
      if (isDuplicateError(error)) return res.status(409).json({ error: 'Email already registered' });
      throw error;
    }

    try {
      await sendVerificationEmail(normalizedEmail, verification.token);
    } catch (error) {
      console.error('Verification email delivery failed:', error);
      return res.status(503).json({
        error: 'Account created, but the verification email could not be sent. Please request another email.',
      });
    }
    return res.json({ message: 'Account created. Check your email to verify your address.' });
  } catch (error) {
    console.error('Registration failed:', error);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/verify-email', async (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'Token required' });

  try {
    const db = getDB();
    const result = await db.run(`UPDATE users
      SET email_verified = 1, verification_token = NULL, verification_token_expires = NULL
      WHERE verification_token = ? AND verification_token_expires > ?`,
    hashOneTimeToken(token), Date.now());
    if (!result.changes) return res.status(400).json({ error: 'Invalid or expired token' });
    return res.json({ message: 'Email verified! You can now sign in.' });
  } catch (error) {
    console.error('Email verification failed:', error);
    return res.status(500).json({ error: 'Email verification failed' });
  }
});

router.post('/resend-verification', async (req, res) => {
  const email = req.body && req.body.email;
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const genericResponse = { message: 'If that account needs verification, an email has been sent.' };
  if (!normalizedEmail) return res.json(genericResponse);

  try {
    const db = getDB();
    const user = await db.get('SELECT id, email_verified FROM users WHERE email = ?', normalizedEmail);
    if (!user || user.email_verified) return res.json(genericResponse);
    const verification = createOneTimeToken();
    await db.run('UPDATE users SET verification_token = ?, verification_token_expires = ? WHERE id = ?',
      verification.tokenHash, Date.now() + 86400000, user.id);
    try {
      await sendVerificationEmail(normalizedEmail, verification.token);
    } catch (error) {
      console.error('Verification email delivery failed:', error);
    }
    return res.json(genericResponse);
  } catch (error) {
    console.error('Verification email request failed:', error);
    return res.status(500).json({ error: 'Could not process verification email request' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (typeof email !== 'string' || typeof password !== 'string')
      return res.status(400).json({ error: 'Email and password are required' });
    const db = getDB();
    const user = await db.get('SELECT * FROM users WHERE email = ?', email.trim().toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    if (user.locked_until && Date.now() < user.locked_until)
      return res.status(429).json({
        error: `Account locked. Try after ${Math.ceil((user.locked_until - Date.now()) / 60000)} minutes.`,
      });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const attempts = (user.failed_attempts || 0) + 1;
      const lockUntil = attempts >= 5 ? Date.now() + 15 * 60 * 1000 : null;
      await db.run('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?',
        attempts, lockUntil, user.id);
      return res.status(401).json({
        error: attempts >= 5 ? 'Account locked for 15 minutes' : 'Invalid email or password',
      });
    }
    if (!user.email_verified)
      return res.status(403).json({ error: 'Please verify your email before signing in', code: 'EMAIL_NOT_VERIFIED' });

    const membership = await db.get(`SELECT w.id AS workspace_id, w.name AS workspace_name, wm.role
      FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ? ORDER BY wm.created_at LIMIT 1`, user.id);
    if (!membership) throw new Error('Account has no workspace membership');
    await db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', user.id);
    const { access, refresh } = makeTokens(user.id);
    await db.run('UPDATE users SET refresh_token = ? WHERE id = ?', refresh, user.id);
    return res.json({
      access_token: access,
      refresh_token: refresh,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        email_verified: user.email_verified,
        workspace: { id: membership.workspace_id, name: membership.workspace_name, role: membership.role },
      },
    });
  } catch (error) {
    console.error('Login failed:', error);
    return res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/refresh', async (req, res) => {
  const { refresh_token: refreshToken } = req.body || {};
  if (!refreshToken) return res.status(401).json({ error: 'Refresh token required' });

  let payload;
  try {
    payload = jwt.verify(refreshToken, JWT_REFRESH);
  } catch {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
  try {
    const db = getDB();
    const { access, refresh } = makeTokens(payload.userId);
    const result = await db.run('UPDATE users SET refresh_token = ? WHERE id = ? AND refresh_token = ?',
      refresh, payload.userId, refreshToken);
    if (!result.changes)
      return res.status(401).json({ error: 'Invalid refresh token' });
    return res.json({ access_token: access, refresh_token: refresh });
  } catch (error) {
    console.error('Token refresh failed:', error);
    return res.status(500).json({ error: 'Could not refresh session' });
  }
});

router.post('/logout', async (req, res) => {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  const refreshToken = req.body?.refresh_token;
  let payload = null;
  let accessTokenValid = false;
  if (accessToken) {
    try {
      payload = jwt.verify(accessToken, JWT_SECRET);
      accessTokenValid = true;
    } catch {
      payload = null;
    }
  }
  if (!payload && typeof refreshToken === 'string') {
    try { payload = jwt.verify(refreshToken, JWT_REFRESH); } catch { payload = null; }
  }
  if (!payload) return res.json({ message: 'Logged out' });

  try {
    const db = getDB();
    if (accessTokenValid) {
      await db.run('UPDATE users SET refresh_token = NULL WHERE id = ?', payload.userId);
    } else {
      await db.run('UPDATE users SET refresh_token = NULL WHERE id = ? AND refresh_token = ?',
        payload.userId, refreshToken);
    }
    return res.json({ message: 'Logged out' });
  } catch (error) {
    console.error('Logout failed:', error);
    return res.status(500).json({ error: 'Could not end session' });
  }
});

router.post('/forgot-password', async (req, res) => {
  const email = req.body?.email;
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const genericResponse = { message: 'If that email exists, a reset link has been sent.' };
  if (!normalizedEmail) return res.json(genericResponse);

  try {
    const db = getDB();
    const user = await db.get('SELECT id, email FROM users WHERE email = ?', normalizedEmail);
    if (user) {
      const reset = createOneTimeToken();
      await db.run('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?',
        reset.tokenHash, Date.now() + 3600000, user.id);
      try {
        await sendPasswordResetEmail(user.email, reset.token);
      } catch (error) {
        console.error('Password reset email delivery failed:', error);
      }
    }
    return res.json(genericResponse);
  } catch (error) {
    console.error('Password reset request failed:', error);
    return res.status(500).json({ error: 'Could not process password reset request' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (typeof token !== 'string' || !token || typeof password !== 'string' || !PASSWORD_PATTERN.test(password))
      return res.status(400).json({
        error: 'Provide a valid reset link and a password with 8+ chars, uppercase, number, and special character',
      });

    const db = getDB();
    const user = await db.get(`SELECT id FROM users
      WHERE reset_token = ? AND reset_token_expires > ?`, hashOneTimeToken(token), Date.now());
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });
    const hash = await bcrypt.hash(password, 12);
    const result = await db.run(`UPDATE users
      SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, refresh_token = NULL
      WHERE id = ? AND reset_token = ? AND reset_token_expires > ?`,
    hash, user.id, hashOneTimeToken(token), Date.now());
    if (!result.changes) return res.status(400).json({ error: 'Invalid or expired reset link' });
    return res.json({ message: 'Password updated successfully. Please sign in again.' });
  } catch (error) {
    console.error('Password reset failed:', error);
    return res.status(500).json({ error: 'Password reset failed' });
  }
});

router.get('/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  try {
    const db = getDB();
    const user = await db.get('SELECT id, name, email, email_verified, created_at FROM users WHERE id = ?', payload.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const workspaces = await db.all(`SELECT w.id, w.name, w.slug, wm.role
      FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ? ORDER BY wm.created_at`, user.id);
    return res.json({ user, workspaces });
  } catch (error) {
    console.error('Could not load account:', error);
    return res.status(500).json({ error: 'Could not load account' });
  }
});

export default router;
