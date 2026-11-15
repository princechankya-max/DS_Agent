import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { io as socketClient } from 'socket.io-client';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function unusedPort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

function socketEvent(socket, event) {
  return new Promise(resolve => socket.once(event, (...args) => resolve(args)));
}

test('demo billing and workspace boundaries work without payment-provider credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-agent-saas-demo-'));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DEMO_MODE: 'true',
      PORT: String(port),
      APP_URL: baseUrl,
      JWT_SECRET: 'demo-access-secret-long-enough-for-tests-123',
      JWT_REFRESH_SECRET: 'demo-refresh-secret-long-enough-for-tests-456',
      DB_PATH: path.join(directory, 'test.sqlite'),
      DATABASE_URL: '',
      UPLOADS_DIR: path.join(directory, 'uploads'),
      OUTPUTS_DIR: path.join(directory, 'outputs'),
      REDIS_URL: '',
      AI_ANALYST_API_KEY: '',
      OBJECT_STORAGE_ENDPOINT: '',
      OBJECT_STORAGE_BUCKET: '',
      OBJECT_STORAGE_ACCESS_KEY: '',
      OBJECT_STORAGE_SECRET_KEY: '',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let deniedSocket;
  let workspaceSocket;

  const waitForServer = async () => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) return;
      } catch {}
      if (child.exitCode !== null) throw new Error(`Demo API failed to start: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out starting demo API: ${output}`);
  };

  try {
    await waitForServer();
    const unknownApiResponse = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(unknownApiResponse.status, 404);
    assert.match(unknownApiResponse.headers.get('content-type'), /application\/json/);

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@dsagent.ai', password: 'Demo@12345' }),
    });
    assert.equal(loginResponse.status, 200);
    const session = await loginResponse.json();
    const headers = { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };
    const personalWorkspaceId = session.user.workspace.id;

    const plansResponse = await fetch(`${baseUrl}/api/billing/plans`);
    const plans = await plansResponse.json();
    assert.equal(plans.plans.find(plan => plan.code === 'pro').checkoutEnabled, true);
    assert.equal(plans.plans.find(plan => plan.code === 'pro').checkoutMode, 'demo');

    const subscriptionResponse = await fetch(`${baseUrl}/api/billing/subscribe`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ plan_code: 'pro' }),
    });
    assert.equal(subscriptionResponse.status, 200);
    assert.equal((await subscriptionResponse.json()).demo_checkout, true);
    const billingResponse = await fetch(`${baseUrl}/api/billing/me`, { headers });
    const billing = await billingResponse.json();
    assert.equal(billing.plan.code, 'pro');
    assert.equal(billing.seats.used, 1);
    assert.equal(billing.seats.billed, 1);
    const seatsResponse = await fetch(`${baseUrl}/api/billing/seats`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ quantity: 2 }),
    });
    assert.equal(seatsResponse.status, 200);
    const multiSeatBilling = await fetch(`${baseUrl}/api/billing/me`, { headers });
    assert.equal((await multiSeatBilling.json()).limit, 200);
    const membershipDb = new Database(path.join(directory, 'test.sqlite'));
    try {
      membershipDb.prepare(`UPDATE workspace_members SET role = 'member'
        WHERE workspace_id = ? AND user_id = ?`).run(personalWorkspaceId, session.user.id);
      const deniedSubscribe = await fetch(`${baseUrl}/api/billing/subscribe`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ plan_code: 'business' }),
      });
      assert.equal(deniedSubscribe.status, 403);
      const deniedCancel = await fetch(`${baseUrl}/api/billing/cancel`, {
        method: 'POST',
        headers,
      });
      assert.equal(deniedCancel.status, 403);
    } finally {
      membershipDb.prepare(`UPDATE workspace_members SET role = 'owner'
        WHERE workspace_id = ? AND user_id = ?`).run(personalWorkspaceId, session.user.id);
      membershipDb.close();
    }
    const expiredSubscriptionDb = new Database(path.join(directory, 'test.sqlite'));
    expiredSubscriptionDb.prepare(`UPDATE workspace_subscriptions SET current_end = ?
      WHERE workspace_id = ?`).run(Math.floor(Date.now() / 1000) - 1, personalWorkspaceId);
    expiredSubscriptionDb.close();
    const expiredBilling = await fetch(`${baseUrl}/api/billing/me`, { headers });
    assert.equal((await expiredBilling.json()).plan.code, 'free');
    const renewedResponse = await fetch(`${baseUrl}/api/billing/subscribe`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ plan_code: 'pro' }),
    });
    assert.equal(renewedResponse.status, 200);

    const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Isolated demo workspace' }),
    });
    assert.equal(workspaceResponse.status, 201);
    const { workspace } = await workspaceResponse.json();
    assert.notEqual(workspace.id, personalWorkspaceId);

    deniedSocket = socketClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token: session.access_token, workspaceId: 'not-a-member-workspace' },
    });
    await socketEvent(deniedSocket, 'connect_error');
    deniedSocket.disconnect();

    workspaceSocket = socketClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token: session.access_token, workspaceId: workspace.id },
    });
    await socketEvent(workspaceSocket, 'connect');
    workspaceSocket.emit('join-job', '00000000-0000-4000-8000-000000000000');
    const [accessDenied] = await socketEvent(workspaceSocket, 'job-access-denied');
    assert.match(accessDenied.error, /not found/);

    const invalidFile = new FormData();
    invalidFile.append('file', new Blob([new Uint8Array([0x00, 0x61])]), 'invalid.csv');
    const invalidUploadResponse = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'X-Workspace-Id': personalWorkspaceId,
      },
      body: invalidFile,
    });
    assert.equal(invalidUploadResponse.status, 400);
    assert.deepEqual(await readdir(path.join(directory, 'uploads', session.user.id)), []);

    const file = new FormData();
    file.append('file', new Blob(['value,group\n1,a\n2,b\n'], { type: 'text/csv' }), 'demo.csv');
    const uploadResponse = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'X-Workspace-Id': personalWorkspaceId,
      },
      body: file,
    });
    assert.equal(uploadResponse.status, 200);
    const uploaded = await uploadResponse.json();

    const analysisResponse = await fetch(`${baseUrl}/api/analysis`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file_id: uploaded.file_id }),
    });
    assert.equal(analysisResponse.status, 202);
    const { job_id: jobId } = await analysisResponse.json();
    let analysis;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      let response;
      try {
        response = await fetch(`${baseUrl}/api/analysis/${jobId}`, { headers });
      } catch (error) {
        throw new Error(`Analysis API stopped responding (exit=${child.exitCode}): ${output}`, { cause: error });
      }
      assert.equal(response.status, 200);
      analysis = await response.json();
      if (!['queued', 'running'].includes(analysis.status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(analysis.status, 'completed', JSON.stringify(analysis.result));

    const analystWithoutConsent = await fetch(`${baseUrl}/api/analysis/${jobId}/questions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ question: 'Show total sales by region' }),
    });
    assert.equal(analystWithoutConsent.status, 400);

    const crossWorkspaceQuestion = await fetch(`${baseUrl}/api/analysis/${jobId}/questions`, {
      method: 'POST',
      headers: { ...headers, 'X-Workspace-Id': workspace.id },
      body: JSON.stringify({ question: 'Show total sales by region', data_consent: true }),
    });
    assert.equal(crossWorkspaceQuestion.status, 404);

    const questionWithoutWorker = await fetch(`${baseUrl}/api/analysis/${jobId}/questions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ question: 'Show total sales by region', data_consent: true }),
    });
    assert.equal(questionWithoutWorker.status, 503);
    assert.match((await questionWithoutWorker.json()).error, /Redis-backed worker/);

    const reportResponse = await fetch(`${baseUrl}/api/analysis/${jobId}/download/eda_report.md`, { headers });
    assert.equal(reportResponse.status, 200);
    assert.match(await reportResponse.text(), /EDA Report/);

    const visualizationFile = analysis.result.viz_info[0].path.split(/[\\/]/).pop();
    const visualizationResponse = await fetch(
      `${baseUrl}/api/analysis/${jobId}/visualizations/${encodeURIComponent(visualizationFile)}`,
      { headers },
    );
    assert.equal(visualizationResponse.status, 200);
    assert.match(visualizationResponse.headers.get('content-type'), /image\/png/);

    const foreignAnalysisResponse = await fetch(`${baseUrl}/api/analysis`, {
      method: 'POST',
      headers: { ...headers, 'X-Workspace-Id': workspace.id },
      body: JSON.stringify({ file_id: uploaded.file_id }),
    });
    assert.equal(foreignAnalysisResponse.status, 404);

    const workspacePlanBefore = await fetch(`${baseUrl}/api/billing/me`, {
      headers: { ...headers, 'X-Workspace-Id': workspace.id },
    });
    assert.equal((await workspacePlanBefore.json()).plan.code, 'free');
  } finally {
    deniedSocket?.disconnect();
    workspaceSocket?.disconnect();
    const exited = new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', resolve);
    });
    child.kill();
    let timeout;
    await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(resolve, 5000); })]);
    clearTimeout(timeout);
    await rm(directory, { recursive: true, force: true });
  }
});
