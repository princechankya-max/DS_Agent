import assert from 'node:assert/strict';
import test from 'node:test';
import { generateQueryPlan, validateQueryPlan } from '../backend/services/aiAnalyst.js';

const columns = [
  { name: 'region', type: 'category' },
  { name: 'sales', type: 'number' },
];

test('AI Analyst sends only a question and schema, then validates the JSON plan', async () => {
  let request;
  const config = {
    apiKey: 'server-only-test-key',
    endpoint: 'https://provider.test/v1/chat/completions',
    model: 'test-model',
    timeoutMs: 1000,
  };
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              operation: 'group_aggregate',
              group_by: 'region',
              measure: 'sales',
              aggregation: 'sum',
              filter: null,
              limit: 10,
            }),
          },
        }],
      }),
    };
  };

  const plan = await generateQueryPlan(
    'Show total sales by region',
    columns,
    { config, fetchImpl },
  );

  assert.equal(request.url, config.endpoint);
  assert.equal(request.options.headers.Authorization, `Bearer ${config.apiKey}`);
  const providerRequest = JSON.parse(request.options.body);
  assert.deepEqual(JSON.parse(providerRequest.messages[1].content), {
    question: 'Show total sales by region',
    columns,
  });
  assert.equal(providerRequest.messages[1].content.includes('raw customer row'), false);
  assert.deepEqual(plan, {
    operation: 'group_aggregate',
    group_by: 'region',
    measure: 'sales',
    aggregation: 'sum',
    filter: null,
    limit: 10,
  });
});

test('AI Analyst rejects code, unknown columns, and invalid filters', () => {
  assert.throws(() => validateQueryPlan({
    operation: 'describe',
    columns: ['sales'],
    python: 'print(1)',
  }, columns), /unsupported query plan fields/);

  assert.throws(() => validateQueryPlan({
    operation: 'value_counts',
    column: 'password',
    limit: 10,
  }, columns), /unavailable or incompatible column/);

  assert.throws(() => validateQueryPlan({
    operation: 'group_aggregate',
    group_by: 'region',
    measure: 'sales',
    aggregation: 'sum',
    filter: { column: 'sales', operator: 'contains', value: '1' },
    limit: 10,
  }, columns), /Text contains filters require/);
});

test('AI Analyst does not expose provider response bodies on errors', async () => {
  const config = {
    apiKey: 'server-only-test-key',
    endpoint: 'https://provider.test/v1/chat/completions',
    model: 'test-model',
    timeoutMs: 1000,
  };
  const fetchImpl = async () => ({ ok: false, status: 401 });

  await assert.rejects(
    generateQueryPlan('Summarize sales', columns, { config, fetchImpl }),
    error => {
      assert.match(error.message, /status 401/);
      assert.equal(error.message.includes(config.apiKey), false);
      return true;
    },
  );
});
