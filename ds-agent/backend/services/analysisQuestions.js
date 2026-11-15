import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDB } from '../db/database.js';
import { downloadFileToPath, isObjectStorageEnabled } from './storage.js';
import { explainQueryResult, generateQueryPlan } from './aiAnalyst.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getDatasetColumns(result) {
  const columns = [
    ...(Array.isArray(result.num_cols) ? result.num_cols.map(name => ({ name, type: 'number' })) : []),
    ...(Array.isArray(result.cat_cols) ? result.cat_cols.map(name => ({ name, type: 'category' })) : []),
  ];
  const unique = [...new Map(columns.filter(column => typeof column.name === 'string')
    .map(column => [column.name, column])).values()];
  if (!unique.length) throw new Error('Analysis has no supported columns for AI questions');
  if (unique.length > 100) throw new Error('AI questions currently support up to 100 columns');
  return unique;
}

function executeDatasetQuery(configPath) {
  const python = process.env.PYTHON_EXECUTABLE || (process.platform === 'win32' ? 'python' : 'python3');
  const enginePath = path.join(__dirname, '../../analysis_engine.py');
  const timeoutMs = Number(process.env.AI_ANALYST_QUERY_TIMEOUT_MS || 60000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000)
    throw new Error('AI_ANALYST_QUERY_TIMEOUT_MS must be between 1000 and 300000');

  return new Promise((resolve, reject) => {
    execFile(
      python,
      [enginePath, '--query-config', configPath],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          if (error.killed || error.code === 'ETIMEDOUT')
            return reject(new Error('Dataset query exceeded its time limit'));
          return reject(new Error('Unable to execute the validated dataset query'));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Dataset query returned an invalid result'));
        }
      },
    );
  });
}

export async function processAnalysisQuestion({ analysisId, workspaceId, question }, provider = {}) {
  if (typeof question !== 'string' || question.trim().length < 5 || question.length > 1000)
    throw new Error('Question must contain 5 to 1000 characters');

  const analysis = await getDB().get(`SELECT status, output_dir, result_json FROM analyses
    WHERE id = ? AND workspace_id = ?`, analysisId, workspaceId);
  if (!analysis) throw new Error('Analysis not found in this workspace');
  if (analysis.status !== 'completed' || !analysis.output_dir || !analysis.result_json)
    throw new Error('AI questions require a completed analysis');

  let analysisResult;
  try {
    analysisResult = JSON.parse(analysis.result_json);
  } catch {
    throw new Error('Analysis result is unavailable');
  }
  const columns = getDatasetColumns(analysisResult);
  const plan = await (provider.generateQueryPlan || generateQueryPlan)(question.trim(), columns);
  const categoricalColumns = columns
    .filter(column => column.type === 'category')
    .map(column => column.name);

  const directory = await mkdtemp(path.join(os.tmpdir(), `ds-agent-question-${analysisId}-`));
  try {
    const objectKey = isObjectStorageEnabled()
      ? path.posix.join(analysis.output_dir, 'cleaned_data.csv')
      : path.join(analysis.output_dir, 'cleaned_data.csv');
    const localPath = path.join(directory, 'cleaned_data.csv');
    const downloaded = await downloadFileToPath(objectKey, localPath);
    const configPath = path.join(directory, 'query.json');
    await writeFile(configPath, JSON.stringify({
      file_path: downloaded.path,
      plan,
      categorical_columns: categoricalColumns,
    }));
    const queryResult = await executeDatasetQuery(configPath);
    const answer = await (provider.explainQueryResult || explainQueryResult)(question.trim(), plan, queryResult);
    return { answer, query_result: queryResult };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
