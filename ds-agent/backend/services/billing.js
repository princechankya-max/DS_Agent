import { createHmac, timingSafeEqual } from 'crypto';
import { PLANS } from '../../shared/plans.js';

const PLAN_ENV_KEYS = {
  pro: 'RAZORPAY_PLAN_PRO_MONTHLY_ID',
  business: 'RAZORPAY_PLAN_BUSINESS_MONTHLY_ID',
};

export function getPlanCheckoutConfig(planCode) {
  const plan = PLANS[planCode];
  if (!plan || planCode === 'free') return null;
  const planId = process.env[PLAN_ENV_KEYS[planCode]];
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET ||
      !process.env.RAZORPAY_WEBHOOK_SECRET || !planId)
    return null;
  return { plan, planId, keyId: process.env.RAZORPAY_KEY_ID };
}

async function razorpayRequest(endpoint, payload, method = 'POST') {
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET)
    throw new Error('Razorpay API credentials are not configured');

  const response = await fetch(`https://api.razorpay.com/v1${endpoint}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.description || 'Razorpay request failed');
    error.providerRejected = response.status < 500;
    throw error;
  }
  return result;
}

export async function createRazorpaySubscription({ planId, user, workspaceId, quantity }) {
  const subscription = await razorpayRequest('/subscriptions', {
    plan_id: planId,
    total_count: 120,
    quantity,
    customer_notify: true,
    notes: { user_id: user.id, workspace_id: workspaceId },
  });
  if (typeof subscription.id !== 'string' || !subscription.id)
    throw new Error('Razorpay did not return a subscription ID');
  return subscription;
}

export async function cancelRazorpaySubscription(subscriptionId) {
  return razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    cancel_at_cycle_end: true,
  });
}

export async function updateRazorpaySubscriptionQuantity(subscriptionId, quantity) {
  return razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    quantity,
    schedule_change_at: 'now',
    customer_notify: true,
  }, 'PATCH');
}

export function verifyCheckoutSignature(paymentId, subscriptionId, signature, secret = process.env.RAZORPAY_KEY_SECRET) {
  if (!paymentId || !subscriptionId || !signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(`${paymentId}|${subscriptionId}`).digest();
  let received;
  try {
    received = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function verifyWebhookSignature(rawBody, signature, secret = process.env.RAZORPAY_WEBHOOK_SECRET) {
  if (!Buffer.isBuffer(rawBody) || !signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let received;
  try {
    received = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}
