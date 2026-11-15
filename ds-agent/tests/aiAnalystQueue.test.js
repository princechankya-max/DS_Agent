import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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

async function waitForOutput(child, readOutput, pattern, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (pattern.test(readOutput())) return;
    if (child.exitCode !== null) throw new Error(`${label} exited unexpectedly: ${readOutput()}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}: ${readOutput()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  let timeout;
  await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(resolve, 5000); })]);
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

test('AI Analyst question is queued, executed by the worker, and workspace-scoped', {
  skip: process.env.AI_ANALYST_E2E !== 'true',
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-agent-analyst-queue-test-'));
  const apiPort = await unusedPort();
  const mockPort = await unusedPort();
  const redisUrl = process.env.AI_ANALYST_TEST_REDIS_URL || 'redis://redis:6379/15';
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const mockCalls = [];
  const mockProvider = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    mockCalls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const isPlanner = mockCalls[mockCalls.length - 1].messages[0].content.includes('safe JSON query plan');
    const content = isPlanner
      ? JSON.stringify({
        operation: 'group_aggregate',
        group_by: 'region',
        measure: 'sales',
        aggregation: 'sum',
        filter: null,
        limit: 10,
      })
      : 'North has the highest total sales in this dataset.';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  mockProvider.listen(mockPort, '0.0.0.0');
  await once(mockProvider, 'listening');

  const environment = {
    ...process.env,
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    PORT: String(apiPort),
    APP_URL: baseUrl,
    JWT_SECRET: 'analyst-e2e-access-secret-long-enough-123',
    JWT_REFRESH_SECRET: 'analyst-e2e-refresh-secret-long-enough-456',
    DATABASE_URL: '',
    DB_PATH: path.join(directory, 'test.sqlite'),
    REDIS_URL: redisUrl,
    AI_ANALYST_API_KEY: 'test-provider-key',
    AI_ANALYST_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    AI_ANALYST_MODEL: 'mock-model',
    UPLOADS_DIR: path.join(directory, 'uploads'),
    OUTPUTS_DIR: path.join(directory, 'outputs'),
    OBJECT_STORAGE_ENDPOINT: '',
    OBJECT_STORAGE_BUCKET: '',
    OBJECT_STORAGE_ACCESS_KEY: '',
    OBJECT_STORAGE_SECRET_KEY: '',
    SMTP_HOST: '',
    SMTP_USER: '',
    SMTP_PASS: '',
  };
  const worker = spawn(process.execPath, ['backend/workers/analysis.js'], {
    cwd: process.cwd(),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const api = spawn(process.execPath, ['backend/server.js'], {
    cwd: process.cwd(),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let workerOutput = '';
  let apiOutput = '';
  for (const stream of [worker.stdout, worker.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => { workerOutput += chunk; });
  }
  for (const stream of [api.stdout, api.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => { apiOutput += chunk; });
  }

  try {
    await waitForOutput(worker, () => workerOutput, /Analysis worker ready/, 'analysis worker');
    let apiReady = false;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) {
          apiReady = true;
          break;
        }
      } catch {}
      if (api.exitCode !== null) throw new Error(`API exited unexpectedly: ${apiOutput}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(apiReady, true, `API failed to start: ${apiOutput}`);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@dsagent.ai', password: 'Demo@12345' }),
    });
    assert.equal(login.status, 200);
    const session = await login.json();
    const headers = {
      Authorization: `Bearer ${session.access_token}`,
      'X-Workspace-Id': session.user.workspace.id,
    };

    const form = new FormData();
    form.append('file', new Blob(['region,sales\nnorth,10\nsouth,7\nnorth,5\n'], { type: 'text/csv' }), 'sales.csv');
    const upload = await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers, body: form });
    assert.equal(upload.status, 200);
    const uploaded = await upload.json();

    const analysisResponse = await fetch(`${baseUrl}/api/analysis`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: uploaded.file_id }),
    });
    assert.equal(analysisResponse.status, 202);
    const { job_id: analysisId } = await analysisResponse.json();
    let analysis;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/analysis/${analysisId}`, { headers });
      analysis = await response.json();
      if (!['queued', 'running'].includes(analysis.status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(analysis.status, 'completed', `${JSON.stringify(analysis)}\nWorker: ${workerOutput}\nAPI: ${apiOutput}`);

    const questionResponse = await fetch(`${baseUrl}/api/analysis/${analysisId}/questions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Show total sales by region', data_consent: true }),
    });
    assert.equal(questionResponse.status, 202);
    const { job_id: questionJobId } = await questionResponse.json();

    let question;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await fetch(
        `${baseUrl}/api/analysis/${analysisId}/questions/${questionJobId}`,
        { headers },
      );
      question = await response.json();
      if (question.status === 'completed' || question.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(question.status, 'completed', JSON.stringify(question));
    assert.equal(question.result.answer, 'North has the highest total sales in this dataset.');
    assert.deepEqual(question.result.query_result.rows, [
      { group: 'north', sum: 15 },
      { group: 'south', sum: 7 },
    ]);
    assert.equal(mockCalls.length, 2);
    assert.equal(JSON.stringify(mockCalls).includes('north,10'), false);
  } finally {
    await stopChild(api);
    await stopChild(worker);
    await new Promise(resolve => mockProvider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
