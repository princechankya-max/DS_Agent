import jwt from 'jsonwebtoken';
import { getDB } from '../db/database.js';

export async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    const db = getDB();
    const user = await db.get(
      'SELECT id, name, email, email_verified FROM users WHERE id = ?',
      payload.userId,
    );
    if (!user) return res.status(401).json({ error: 'User not found' });

    const requestedWorkspace = req.get('x-workspace-id');
    const membership = requestedWorkspace
      ? await db.get(`SELECT w.id, w.name, wm.role FROM workspace_members wm
          JOIN workspaces w ON w.id = wm.workspace_id
          WHERE wm.user_id = ? AND wm.workspace_id = ?`, user.id, requestedWorkspace)
      : await db.get(`SELECT w.id, w.name, wm.role FROM workspace_members wm
          JOIN workspaces w ON w.id = wm.workspace_id
          WHERE wm.user_id = ? ORDER BY wm.created_at LIMIT 1`, user.id);
    if (!membership)
      return res.status(403).json({ error: 'Workspace access denied', code: 'WORKSPACE_ACCESS_DENIED' });

    req.user = user;
    req.workspace = { id: membership.id, name: membership.name, role: membership.role };
    return next();
  } catch (error) {
    console.error('Authentication lookup failed:', error);
    return res.status(500).json({ error: 'Could not validate account access' });
  }
}

export function requireWorkspaceRole(...roles) {
  return (req, res, next) => {
    if (!req.workspace || !roles.includes(req.workspace.role))
      return res.status(403).json({ error: 'Workspace administrator permission required' });
    return next();
  };
}
