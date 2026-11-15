import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('AI Analyst executes a validated aggregate locally and scopes analysis to its workspace', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-agent-analyst-test-'));
  const environment = {
    DB_PATH: process.env.DB_PATH,
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    DEMO_MODE: process.env.DEMO_MODE,
    OBJECT_STORAGE_ENDPOINT: process.env.OBJECT_STORAGE_ENDPOINT,
    OBJECT_STORAGE_BUCKET: process.env.OBJECT_STORAGE_BUCKET,
    OBJECT_STORAGE_ACCESS_KEY: process.env.OBJECT_STORAGE_ACCESS_KEY,
    OBJECT_STORAGE_SECRET_KEY: process.env.OBJECT_STORAGE_SECRET_KEY,
    AI_ANALYST_QUERY_TIMEOUT_MS: process.env.AI_ANALYST_QUERY_TIMEOUT_MS,
  };
  process.env.DB_PATH = path.join(directory, 'test.sqlite');
  process.env.DATABASE_URL = '';
  process.env.NODE_ENV = 'test';
  process.env.DEMO_MODE = 'false';
  process.env.OBJECT_STORAGE_ENDPOINT = '';
  process.env.OBJECT_STORAGE_BUCKET = '';
  process.env.OBJECT_STORAGE_ACCESS_KEY = '';
  process.env.OBJECT_STORAGE_SECRET_KEY = '';
  process.env.AI_ANALYST_QUERY_TIMEOUT_MS = '20000';

  let closeDatabase;
  try {
    const databaseModule = await import('../backend/db/database.js');
    closeDatabase = databaseModule.closeDB;
    await databaseModule.initDB();
    const db = databaseModule.getDB();
    const suffix = Date.now();
    const userId = `analyst-user-${suffix}`;
    const workspaceId = `analyst-workspace-${suffix}`;
    const analysisId = `analyst-analysis-${suffix}`;
    const outputDirectory = path.join(directory, 'output');
    await mkdir(outputDirectory);
    await writeFile(path.join(outputDirectory, 'cleaned_data.csv'), [
      'region,sales',
      'north,10',
      'south,7',
      'north,5',
    ].join('\n'), 'utf8');

    await db.run(`INSERT INTO users (id, name, email, password_hash, email_verified)
      VALUES (?, ?, ?, ?, 1)`, userId, 'AI Analyst Test', `analyst-${suffix}@example.test`, 'not-used');
    await db.run(`INSERT INTO workspaces (id, name, slug, owner_user_id)
      VALUES (?, ?, ?, ?)`, workspaceId, 'Analyst Test', `analyst-${suffix}`, userId);
    await db.run(`INSERT INTO analyses
      (id, workspace_id, user_id, name, status, output_dir, result_json)
      VALUES (?, ?, ?, ?, 'completed', ?, ?)`,
    analysisId,
    workspaceId,
    userId,
    'Analyst test',
    outputDirectory,
    JSON.stringify({ num_cols: ['sales'], cat_cols: ['region'] }));

    const { processAnalysisQuestion } = await import('../backend/services/analysisQuestions.js');
    const result = await processAnalysisQuestion({
      analysisId,
      workspaceId,
      question: 'Show total sales by region',
    }, {
      generateQueryPlan: async (_question, columns) => {
        assert.deepEqual(columns, [
          { name: 'sales', type: 'number' },
          { name: 'region', type: 'category' },
        ]);
        return {
          operation: 'group_aggregate',
          group_by: 'region',
          measure: 'sales',
          aggregation: 'sum',
          filter: null,
          limit: 10,
        };
      },
      explainQueryResult: async (_question, _plan, queryResult) =>
        `Returned ${queryResult.rows.length} regions.`,
    });

    assert.equal(result.answer, 'Returned 2 regions.');
    assert.deepEqual(result.query_result.rows, [
      { group: 'north', sum: 15 },
      { group: 'south', sum: 7 },
    ]);
    await assert.rejects(
      processAnalysisQuestion({
        analysisId,
        workspaceId: 'another-workspace',
        question: 'Show total sales by region',
      }),
      /Analysis not found in this workspace/,
    );
  } finally {
    if (closeDatabase) await closeDatabase();
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
