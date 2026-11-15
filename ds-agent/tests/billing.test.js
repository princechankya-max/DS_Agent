import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import Database from 'better-sqlite3';
import test from 'node:test';
import { getPlanEntitlements } from '../backend/services/planEntitlements.js';
import { verifyCheckoutSignature, verifyWebhookSignature } from '../backend/services/billing.js';

test('checkout and webhook signatures are validated with timing-safe HMAC inputs', () => {
  const paymentId = 'pay_test';
  const subscriptionId = 'sub_test';
  const keySecret = 'test-key-secret';
  const checkoutSignature = createHmac('sha256', keySecret)
    .update(`${paymentId}|${subscriptionId}`).digest('hex');
  assert.equal(verifyCheckoutSignature(paymentId, subscriptionId, checkoutSignature, keySecret), true);
  assert.equal(verifyCheckoutSignature(paymentId, subscriptionId, 'invalid', keySecret), false);

  const rawBody = Buffer.from('{"event":"subscription.activated"}');
  const webhookSecret = 'test-webhook-secret';
  const webhookSignature = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  assert.equal(verifyWebhookSignature(rawBody, webhookSignature, webhookSecret), true);
  assert.equal(verifyWebhookSignature(Buffer.from('{}'), webhookSignature, webhookSecret), false);
});

test('workspace entitlements use active subscriptions and enforce the free monthly limit', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE analyses (workspace_id TEXT, created_at INTEGER);
    CREATE TABLE workspace_subscriptions (
      workspace_id TEXT, plan_code TEXT, status TEXT, razorpay_subscription_id TEXT,
      current_start INTEGER, current_end INTEGER, cancel_at_cycle_end INTEGER, quantity INTEGER
    );`);
  const adapter = {
    get: async (sql, ...params) => db.prepare(sql).get(...params),
  };

  const now = new Date('2026-11-13T00:00:00Z');
  const monthStart = Math.floor(Date.UTC(2026, 10, 1) / 1000);
  const addAnalysis = db.prepare('INSERT INTO analyses (workspace_id, created_at) VALUES (?, ?)');
  for (let index = 0; index < 10; index += 1) addAnalysis.run('workspace-1', monthStart + index);
  addAnalysis.run('workspace-1', monthStart - 1);

  const free = await getPlanEntitlements(adapter, 'workspace-1', now);
  assert.equal(free.used, 10);
  assert.equal(free.remaining, 0);

  db.prepare(`INSERT INTO workspace_subscriptions (workspace_id, plan_code, status, current_end)
    VALUES ('workspace-1', 'pro', 'active', ?)`).run(Math.floor(now.getTime() / 1000) + 3600);
  const pro = await getPlanEntitlements(adapter, 'workspace-1', now);
  assert.equal(pro.plan.code, 'pro');
  assert.equal(pro.limit, 100);
  assert.equal(pro.remaining, 90);

  db.prepare(`UPDATE workspace_subscriptions SET quantity = 2 WHERE workspace_id = 'workspace-1'`).run();
  const multiSeatPro = await getPlanEntitlements(adapter, 'workspace-1', now);
  assert.equal(multiSeatPro.limit, 200);
  assert.equal(multiSeatPro.remaining, 190);

  db.prepare(`UPDATE workspace_subscriptions SET current_end = ? WHERE workspace_id = 'workspace-1'`)
    .run(Math.floor(now.getTime() / 1000) - 1);
  assert.equal((await getPlanEntitlements(adapter, 'workspace-1', now)).plan.code, 'free');
  db.close();
});
