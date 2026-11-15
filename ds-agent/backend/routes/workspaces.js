import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { createOneTimeToken, hashOneTimeToken } from '../security/oneTimeTokens.js';
import { sendWorkspaceInvitationEmail } from '../services/email.js';

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const workspaces = await getDB().all(`SELECT w.id, w.name, w.slug, wm.role
      FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ? ORDER BY wm.created_at`, req.user.id);
    return res.json({ workspaces });
  } catch (error) {
    console.error('Could not list workspaces:', error);
    return res.status(500).json({ error: 'Could not list workspaces' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 100) return res.status(400).json({ error: 'Workspace name must be 1-100 characters' });

  const id = uuidv4();
  try {
    await getDB().transaction(async db => {
      await db.run('INSERT INTO workspaces (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)',
        id, name, `workspace-${id}`, req.user.id);
      await db.run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')",
        id, req.user.id);
    });
    return res.status(201).json({ workspace: { id, name, role: 'owner' } });
  } catch (error) {
    console.error('Could not create workspace:', error);
    return res.status(500).json({ error: 'Could not create workspace' });
  }
});

router.get('/:workspaceId/members', requireAuth, async (req, res) => {
  try {
    const access = await getDB().get(`SELECT role FROM workspace_members
      WHERE workspace_id = ? AND user_id = ?`, req.params.workspaceId, req.user.id);
    if (!access) return res.status(403).json({ error: 'Workspace access denied' });
    const members = await getDB().all(`SELECT u.id, u.name, u.email, wm.role, wm.created_at
      FROM workspace_members wm JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = ? ORDER BY wm.created_at`, req.params.workspaceId);
    return res.json({ members });
  } catch (error) {
    console.error('Could not list workspace members:', error);
    return res.status(500).json({ error: 'Could not list workspace members' });
  }
});

router.post('/:workspaceId/invitations', requireAuth, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const role = req.body?.role === 'admin' ? 'admin' : 'member';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Enter a valid email address' });
  try {
    const db = getDB();
    const workspace = await db.get(`SELECT w.id, w.name, wm.role FROM workspaces w
      JOIN workspace_members wm ON wm.workspace_id = w.id
      WHERE w.id = ? AND wm.user_id = ?`, req.params.workspaceId, req.user.id);
    if (!workspace || !['owner', 'admin'].includes(workspace.role))
      return res.status(403).json({ error: 'Workspace administrator permission required' });
    const existing = await db.get(`SELECT wm.user_id FROM workspace_members wm
      JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? AND u.email = ?`,
    workspace.id, email);
    if (existing) return res.status(409).json({ error: 'This user is already a workspace member' });

    const invite = createOneTimeToken();
    await db.run(`INSERT INTO workspace_invitations
      (id, workspace_id, email, role, token_hash, expires_at, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(workspace_id, email) DO UPDATE SET role = excluded.role, token_hash = excluded.token_hash,
        expires_at = excluded.expires_at, accepted_at = NULL`,
    uuidv4(), workspace.id, email, role, invite.tokenHash, Date.now() + 7 * 86400000);
    await sendWorkspaceInvitationEmail(email, invite.token, workspace.name);
    return res.status(202).json({ message: 'Invitation sent. It expires in 7 days.' });
  } catch (error) {
    console.error('Could not send workspace invitation:', error);
    return res.status(500).json({ error: 'Could not send workspace invitation' });
  }
});

router.post('/invitations/accept', requireAuth, async (req, res) => {
  const token = req.body?.token;
  if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'Invitation token required' });
  if (!req.user.email_verified) return res.status(403).json({ error: 'Verify your email before accepting an invitation' });
  try {
    const db = getDB();
    const acceptance = await db.transaction(async transaction => {
      const invitation = await transaction.get(`SELECT id, workspace_id, email, role FROM workspace_invitations
        WHERE token_hash = ? AND email = ? AND expires_at > ? AND accepted_at IS NULL`,
      hashOneTimeToken(token), req.user.email.toLowerCase(), Date.now());
      if (!invitation) return { invalid: true };
      await transaction.lockWorkspace(invitation.workspace_id);

      const subscription = await transaction.get(`SELECT status, quantity FROM workspace_subscriptions
        WHERE workspace_id = ?`, invitation.workspace_id);
      const membership = await transaction.get(
        'SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ?',
        invitation.workspace_id,
      );
      const seatLimit = subscription?.status === 'active' ? Number(subscription.quantity) : 1;
      if (Number(membership.count) >= seatLimit) return { seatLimit: true };

      await transaction.run('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
        invitation.workspace_id, req.user.id, invitation.role);
      await transaction.run('UPDATE workspace_invitations SET accepted_at = ? WHERE id = ?',
        Date.now(), invitation.id);
      return { workspaceId: invitation.workspace_id };
    });
    if (acceptance.invalid) return res.status(400).json({ error: 'Invalid, expired, or already used invitation' });
    if (acceptance.seatLimit)
      return res.status(409).json({
        error: 'No unassigned seats. A workspace owner must add a seat before accepting this invitation.',
        code: 'SEAT_LIMIT_REACHED',
      });
    return res.json({ message: 'Invitation accepted', workspace_id: acceptance.workspaceId });
  } catch (error) {
    console.error('Could not accept workspace invitation:', error);
    return res.status(500).json({ error: 'Could not accept workspace invitation' });
  }
});

router.delete('/:workspaceId/members/:userId', requireAuth, async (req, res) => {
  try {
    const db = getDB();
    const workspace = await db.get('SELECT owner_user_id FROM workspaces WHERE id = ?', req.params.workspaceId);
    const membership = await db.get('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      req.params.workspaceId, req.user.id);
    if (!workspace || !membership || !['owner', 'admin'].includes(membership.role))
      return res.status(403).json({ error: 'Workspace administrator permission required' });
    if (req.params.userId === workspace.owner_user_id)
      return res.status(400).json({ error: 'Workspace owner cannot be removed' });
    const result = await db.run('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      req.params.workspaceId, req.params.userId);
    if (!result.changes) return res.status(404).json({ error: 'Workspace member not found' });
    return res.json({ message: 'Workspace member removed' });
  } catch (error) {
    console.error('Could not remove workspace member:', error);
    return res.status(500).json({ error: 'Could not remove workspace member' });
  }
});

export default router;
