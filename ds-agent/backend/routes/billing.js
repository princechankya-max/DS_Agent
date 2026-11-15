import express from 'express';
import rateLimit from 'express-rate-limit';
import { getDB } from '../db/database.js';
import { requireAuth, requireWorkspaceRole } from '../middleware/auth.js';
import {
  cancelRazorpaySubscription,
  createRazorpaySubscription,
  getPlanCheckoutConfig,
  updateRazorpaySubscriptionQuantity,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from '../services/billing.js';
import { PLANS } from '../../shared/plans.js';
import { getPlanEntitlements } from '../services/planEntitlements.js';

const router = express.Router();
const ACTIVE_STATUSES = new Set(['creating', 'active', 'authenticated', 'created', 'pending', 'halted']);
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many billing attempts. Try again later.' },
});
const demoBillingEnabled = () => process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production';

async function currentSubscription(db, workspaceId) {
  return await db.get(`SELECT plan_code, status, razorpay_subscription_id, current_start,
    current_end, cancel_at_cycle_end, quantity FROM workspace_subscriptions WHERE workspace_id = ?`,
  workspaceId) || null;
}

router.post('/webhook', async (req, res) => {
  const signature = req.get('x-razorpay-signature');
  const rawBody = req.body;
  if (!verifyWebhookSignature(rawBody, signature))
    return res.status(400).json({ error: 'Invalid webhook signature' });

  const eventId = req.get('x-razorpay-event-id');
  if (!eventId) return res.status(400).json({ error: 'Webhook event ID is required' });
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }

  const entity = event.payload?.subscription?.entity;
  const stateByEvent = {
    'subscription.activated': 'active',
    'subscription.charged': 'active',
    'subscription.authenticated': 'authenticated',
    'subscription.pending': 'pending',
    'subscription.halted': 'halted',
    'subscription.paused': 'paused',
    'subscription.resumed': 'active',
    'subscription.cancelled': 'cancelled',
    'subscription.completed': 'completed',
  };
  try {
    const processed = await getDB().transaction(async db => {
      const inserted = await db.run(
        'INSERT INTO razorpay_webhook_events (event_id, event_type) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING',
        eventId,
        event.event || 'unknown',
      );
      if (!inserted.changes) return false;
      const nextStatus = stateByEvent[event.event];
      if (entity?.id && nextStatus) {
        await db.run(`UPDATE workspace_subscriptions
          SET status = ?, current_start = ?, current_end = ?, updated_at = unixepoch()
          WHERE razorpay_subscription_id = ?`,
        nextStatus, entity.current_start || null, entity.current_end || null, entity.id);
      }
      return true;
    });
    return res.json({ received: true, duplicate: !processed });
  } catch (error) {
    console.error('Razorpay webhook processing failed:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

router.get('/plans', (req, res) => {
  res.json({
    plans: Object.values(PLANS).map(plan => ({
      ...plan,
      checkoutEnabled: plan.code === 'free' || demoBillingEnabled() || Boolean(getPlanCheckoutConfig(plan.code)),
      checkoutMode: demoBillingEnabled() ? 'demo' : 'razorpay',
    })),
  });
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const db = getDB();
    const [entitlements, members] = await Promise.all([
      getPlanEntitlements(db, req.workspace.id),
      db.get('SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ?', req.workspace.id),
    ]);
    return res.json({
      ...entitlements,
      workspace: req.workspace,
      seats: { used: Number(members.count), billed: Number(entitlements.subscription?.quantity || 1) },
    });
  } catch (error) {
    console.error('Could not load billing details:', error);
    return res.status(500).json({ error: 'Could not load billing details' });
  }
});

router.post('/seats', requireAuth, async (req, res) => {
  const quantity = Number(req.body?.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100)
    return res.status(400).json({ error: 'Seat quantity must be an integer between 1 and 100' });
  if (!['owner', 'admin'].includes(req.workspace.role))
    return res.status(403).json({ error: 'Workspace administrator permission required' });
  try {
    const db = getDB();
    const updated = await db.transaction(async transaction => {
      await transaction.lockWorkspace(req.workspace.id);
      const subscription = await currentSubscription(transaction, req.workspace.id);
      if (subscription?.status !== 'active') return { missingSubscription: true };
      const members = await transaction.get(
        'SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ?',
        req.workspace.id,
      );
      if (quantity < Number(members.count)) return { tooFewSeats: true };
      const isDemoSubscription = subscription.razorpay_subscription_id?.startsWith('demo_sub_');
      if (isDemoSubscription) {
        if (!demoBillingEnabled()) return { demoUnavailable: true };
      } else {
        if (!subscription.razorpay_subscription_id) return { providerMissing: true };
        await updateRazorpaySubscriptionQuantity(subscription.razorpay_subscription_id, quantity);
      }
      await transaction.run(`UPDATE workspace_subscriptions
        SET quantity = ?, updated_at = unixepoch() WHERE workspace_id = ?`, quantity, req.workspace.id);
      return { isDemoSubscription };
    });
    if (updated.missingSubscription)
      return res.status(409).json({ error: 'Activate a paid workspace plan before changing seats' });
    if (updated.tooFewSeats)
      return res.status(409).json({ error: 'Seat quantity cannot be lower than the current workspace member count' });
    if (updated.demoUnavailable)
      return res.status(409).json({ error: 'Demo subscription is not available here' });
    if (updated.providerMissing)
      return res.status(409).json({ error: 'Subscription provider has not assigned an ID yet' });
    return res.json({
      message: `${updated.isDemoSubscription ? 'Demo billing' : 'Subscription'} updated to ${quantity} seat${quantity === 1 ? '' : 's'}.`,
      quantity,
    });
  } catch (error) {
    console.error('Could not update subscription seats:', error);
    return res.status(502).json({ error: 'Could not update subscription seats' });
  }
});

router.post('/subscribe', checkoutLimiter, requireAuth, requireWorkspaceRole('owner', 'admin'), async (req, res) => {
  const planCode = req.body?.plan_code;
  const plan = PLANS[planCode];
  if (!plan || planCode === 'free') return res.status(400).json({ error: 'Choose a paid plan' });
  if (!demoBillingEnabled() && !getPlanCheckoutConfig(planCode))
    return res.status(503).json({ error: 'This paid plan is not configured for checkout yet' });
  if (!req.user.email_verified)
    return res.status(403).json({ error: 'Verify your email before starting a subscription' });

  try {
    const db = getDB();
    const existing = await currentSubscription(db, req.workspace.id);
    const periodExpired = existing?.current_end != null &&
      Number(existing.current_end) * 1000 <= Date.now();
    if (existing && !periodExpired) {
      if (existing.status === 'active' && existing.plan_code === planCode)
        return res.status(409).json({ error: 'This workspace already has this plan active' });
      if (ACTIVE_STATUSES.has(existing.status))
        return res.status(409).json({ error: 'An active or pending subscription already exists' });
    }

    const seatCount = await db.get(
      'SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ?',
      req.workspace.id,
    );
    const quantity = Math.max(1, Number(seatCount.count));
    if (demoBillingEnabled()) {
      const currentStart = Math.floor(Date.now() / 1000);
      const currentEnd = currentStart + 30 * 24 * 60 * 60;
      await db.run(`INSERT INTO workspace_subscriptions
        (workspace_id, razorpay_subscription_id, plan_code, status, quantity, current_start, current_end,
         cancel_at_cycle_end, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?, 0, unixepoch(), unixepoch())
        ON CONFLICT(workspace_id) DO UPDATE SET razorpay_subscription_id = excluded.razorpay_subscription_id,
          plan_code = excluded.plan_code, status = 'active', quantity = excluded.quantity,
          current_start = excluded.current_start, current_end = excluded.current_end,
          cancel_at_cycle_end = 0, updated_at = unixepoch()`,
      req.workspace.id, `demo_sub_${req.workspace.id}`, planCode, quantity, currentStart, currentEnd);
      return res.json({
        demo_checkout: true,
        message: 'Demo plan activated. No payment was made.',
        plan: { code: plan.code, name: plan.name, priceInr: plan.priceInr, quantity },
      });
    }

    const config = getPlanCheckoutConfig(planCode);
    const reservation = await db.run(`INSERT INTO workspace_subscriptions
      (workspace_id, razorpay_subscription_id, plan_code, status, quantity, created_at, updated_at)
      VALUES (?, NULL, ?, 'creating', ?, unixepoch(), unixepoch())
      ON CONFLICT(workspace_id) DO UPDATE SET razorpay_subscription_id = NULL, plan_code = excluded.plan_code,
        status = 'creating', quantity = excluded.quantity, current_start = NULL, current_end = NULL,
        cancel_at_cycle_end = 0, updated_at = unixepoch()
      WHERE workspace_subscriptions.status NOT IN ('active', 'authenticated', 'created', 'pending', 'halted')
        OR (workspace_subscriptions.status = 'active' AND workspace_subscriptions.current_end IS NOT NULL
          AND workspace_subscriptions.current_end <= unixepoch())`,
    req.workspace.id, planCode, quantity);
    if (!reservation.changes)
      return res.status(409).json({ error: 'A subscription request is already in progress' });

    try {
      const subscription = await createRazorpaySubscription({
        planId: config.planId,
        user: req.user,
        workspaceId: req.workspace.id,
        quantity,
      });
      await db.run(`UPDATE workspace_subscriptions SET razorpay_subscription_id = ?, status = 'created',
        updated_at = unixepoch() WHERE workspace_id = ? AND status = 'creating'`,
      subscription.id, req.workspace.id);
      return res.json({
        key_id: config.keyId,
        subscription_id: subscription.id,
        plan: { code: plan.code, name: plan.name, priceInr: plan.priceInr, quantity },
        prefill: { name: req.user.name, email: req.user.email },
      });
    } catch (error) {
      if (error.providerRejected)
        await db.run(`UPDATE workspace_subscriptions SET status = 'failed', updated_at = unixepoch()
          WHERE workspace_id = ? AND status = 'creating'`, req.workspace.id);
      console.error('Razorpay subscription creation failed:', error);
      return res.status(502).json({ error: 'Could not start checkout with Razorpay' });
    }
  } catch (error) {
    console.error('Subscription request failed:', error);
    return res.status(500).json({ error: 'Could not start subscription' });
  }
});

router.post('/verify', checkoutLimiter, requireAuth, requireWorkspaceRole('owner', 'admin'), async (req, res) => {
  const {
    razorpay_payment_id: paymentId,
    razorpay_subscription_id: subscriptionId,
    razorpay_signature: signature,
  } = req.body || {};
  if (!verifyCheckoutSignature(paymentId, subscriptionId, signature))
    return res.status(400).json({ error: 'Invalid Razorpay checkout signature' });
  try {
    const result = await getDB().run(`UPDATE workspace_subscriptions
      SET status = 'authenticated', updated_at = unixepoch()
      WHERE workspace_id = ? AND razorpay_subscription_id = ? AND status IN ('created', 'authenticated')`,
    req.workspace.id, subscriptionId);
    if (!result.changes) return res.status(404).json({ error: 'Subscription not found for this workspace' });
    return res.json({ message: 'Payment details verified. Subscription activates after Razorpay confirms it.' });
  } catch (error) {
    console.error('Checkout verification failed:', error);
    return res.status(500).json({ error: 'Could not verify checkout' });
  }
});

router.post('/cancel', checkoutLimiter, requireAuth, requireWorkspaceRole('owner', 'admin'), async (req, res) => {
  try {
    const db = getDB();
    const subscription = await currentSubscription(db, req.workspace.id);
    if (!subscription?.razorpay_subscription_id || subscription.status !== 'active')
      return res.status(404).json({ error: 'No active subscription to cancel' });
    if (subscription.razorpay_subscription_id.startsWith('demo_sub_')) {
      await db.run(`UPDATE workspace_subscriptions
        SET cancel_at_cycle_end = 1, updated_at = unixepoch() WHERE workspace_id = ?`, req.workspace.id);
      return res.json({ message: 'Demo cancellation scheduled for the end of the billing cycle.' });
    }
    await cancelRazorpaySubscription(subscription.razorpay_subscription_id);
    await db.run(`UPDATE workspace_subscriptions
      SET cancel_at_cycle_end = 1, updated_at = unixepoch() WHERE workspace_id = ?`, req.workspace.id);
    return res.json({ message: 'Cancellation scheduled for the end of the billing cycle.' });
  } catch (error) {
    console.error('Subscription cancellation failed:', error);
    return res.status(502).json({ error: 'Could not cancel subscription' });
  }
});

export default router;
