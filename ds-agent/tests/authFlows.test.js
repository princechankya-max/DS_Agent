import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import jwt from 'jsonwebtoken';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

async function unusedPort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForLink(child, readOutput, pattern, baseUrl, startIndex = 0) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const match = readOutput().slice(startIndex).match(pattern);
    if (match) return new URL(match[0], baseUrl);
    if (child.exitCode !== null) throw new Error('API process exited before generating a development email');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the development email link');
}

test('email verification and password reset use private, expiring, one-time tokens', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-agent-auth-test-'));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const accessSecret = 'test-access-token-secret-which-is-long-enough';
  const refreshSecret = 'different-test-refresh-secret-long-enough';
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEMO_MODE: 'false',
      PORT: String(port),
      APP_URL: 'http://localhost:5173',
      JWT_SECRET: accessSecret,
      JWT_REFRESH_SECRET: refreshSecret,
      DATABASE_URL: '',
      REDIS_URL: '',
      OBJECT_STORAGE_ENDPOINT: '',
      OBJECT_STORAGE_BUCKET: '',
      OBJECT_STORAGE_ACCESS_KEY: '',
      OBJECT_STORAGE_SECRET_KEY: '',
      DB_PATH: path.join(directory, 'test.sqlite'),
      UPLOADS_DIR: path.join(directory, 'uploads'),
      OUTPUTS_DIR: path.join(directory, 'outputs'),
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

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {}
      if (child.exitCode !== null) throw new Error('API process failed during startup');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'API did not start in time');

    const email = `auth-${Date.now()}@example.test`;
    const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Auth Test', email, password: 'StrongPass@123' }),
    });
    const registration = await registerResponse.json();
    assert.equal(registerResponse.status, 200);
    assert.equal(registration.dev_verification_token, undefined);

    const login = async password => fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const unverifiedLogin = await login('StrongPass@123');
    assert.equal(unverifiedLogin.status, 403);
    assert.equal((await unverifiedLogin.json()).code, 'EMAIL_NOT_VERIFIED');

    const verifyLink = await waitForLink(child, () => output, /verify-email\?token=[A-Za-z0-9_-]+/, baseUrl);
    const verifyRequest = () => fetch(`${baseUrl}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: verifyLink.searchParams.get('token') }),
    });
    const verificationResponses = await Promise.all([verifyRequest(), verifyRequest()]);
    assert.deepEqual(verificationResponses.map(response => response.status).sort(), [200, 400]);
    const loginResponse = await login('StrongPass@123');
    assert.equal(loginResponse.status, 200);
    const session = await loginResponse.json();
    const billingResponse = await fetch(`${baseUrl}/api/billing/me`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const billing = await billingResponse.json();
    assert.equal(billing.plan.code, 'free');
    assert.equal(billing.plan.analysesPerMonth, 10);
    const checkoutResponse = await fetch(`${baseUrl}/api/billing/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ plan_code: 'pro' }),
    });
    assert.equal(checkoutResponse.status, 503);

    const forgotResponse = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const forgotBody = await forgotResponse.json();
    assert.equal(forgotResponse.status, 200);
    assert.equal(forgotBody.reset_token, undefined);
    const resetLink = await waitForLink(child, () => output, /reset-password\?token=[A-Za-z0-9_-]+/, baseUrl);
    const expiredToken = resetLink.searchParams.get('token');
    const db = new Database(path.join(directory, 'test.sqlite'));
    db.prepare('UPDATE users SET reset_token_expires = ? WHERE email = ?').run(Date.now() - 1, email);
    db.close();

    const expiredResponse = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: expiredToken, password: 'UpdatedPass@456' }),
    });
    assert.equal(expiredResponse.status, 400);

    const outputStart = output.length;
    const secondForgotResponse = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    assert.equal(secondForgotResponse.status, 200);
    const resetLinkAgain = await waitForLink(child, () => output, /reset-password\?token=[A-Za-z0-9_-]+/, baseUrl, outputStart);
    const resetToken = resetLinkAgain.searchParams.get('token');

    const passwords = ['UpdatedPass@456', 'AnotherPass@789'];
    const resetRequests = passwords.map(password => fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, password }),
    }));
    const resetResponses = await Promise.all(resetRequests);
    assert.deepEqual(resetResponses.map(response => response.status).sort(), [200, 400]);
    const winningPassword = passwords[resetResponses.findIndex(response => response.status === 200)];
    assert.equal((await login(winningPassword)).status, 200);

    const sessionResponse = await login(winningPassword);
    const refreshedSession = await sessionResponse.json();
    const refreshRequest = () => fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshedSession.refresh_token }),
    });
    const refreshResponses = await Promise.all([refreshRequest(), refreshRequest()]);
    assert.deepEqual(refreshResponses.map(response => response.status).sort(), [200, 401]);
    const successfulRefresh = await refreshResponses.find(response => response.status === 200).json();
    const expiredAccessToken = jwt.sign({ userId: refreshedSession.user.id }, accessSecret, { expiresIn: -1 });
    const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${expiredAccessToken}` },
      body: JSON.stringify({ refresh_token: successfulRefresh.refresh_token }),
    });
    assert.equal(logoutResponse.status, 200);
    const revokedRefreshResponse = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: successfulRefresh.refresh_token }),
    });
    assert.equal(revokedRefreshResponse.status, 401);
  } finally {
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
