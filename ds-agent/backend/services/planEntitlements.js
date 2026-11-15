import { PLANS } from '../../shared/plans.js';

export async function getPlanEntitlements(db, workspaceId, now = new Date()) {
  const subscription = await db.get(`SELECT plan_code, status, razorpay_subscription_id, current_start,
    current_end, cancel_at_cycle_end, quantity FROM workspace_subscriptions WHERE workspace_id = ?`,
  workspaceId) || null;
  const currentEnd = Number(subscription?.current_end || 0);
  const isCurrent = subscription?.status === 'active' && (!currentEnd || currentEnd * 1000 > now.getTime());
  const plan = isCurrent ? (PLANS[subscription.plan_code] || PLANS.free) : PLANS.free;
  const quantity = isCurrent ? Math.max(1, Number(subscription.quantity || 1)) : 1;
  const limit = plan.analysesPerMonth * quantity;
  const calendarStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodStart = isCurrent && subscription.current_start
    ? Number(subscription.current_start)
    : Math.floor(calendarStart.getTime() / 1000);
  const periodEnd = isCurrent && currentEnd ? currentEnd : null;
  const usage = periodEnd
    ? await db.get(`SELECT COUNT(*) AS count FROM analyses
        WHERE workspace_id = ? AND created_at >= ? AND created_at < ?`,
    workspaceId, periodStart, periodEnd)
    : await db.get('SELECT COUNT(*) AS count FROM analyses WHERE workspace_id = ? AND created_at >= ?',
      workspaceId, periodStart);
  const used = Number(usage?.count || 0);

  return {
    plan,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    subscription,
  };
}
