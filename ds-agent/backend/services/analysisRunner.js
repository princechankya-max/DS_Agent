import { spawn } from 'child_process';
import fs from 'fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDB } from '../db/database.js';
import {
  deletePrefix,
  downloadFileToPath,
  getWorkspaceAnalysisPrefix,
  isObjectStorageEnabled,
  uploadDirectory,
} from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUTS_DIR = process.env.OUTPUTS_DIR || path.join(__dirname, '../../outputs');

function runPython(configPath, onProgress) {
  const enginePath = path.join(__dirname, '../../analysis_engine.py');
  const python = process.env.PYTHON_EXECUTABLE || (process.platform === 'win32' ? 'python' : 'python3');
  return new Promise((resolve, reject) => {
    const processHandle = spawn(python, [enginePath, '--config', configPath]);
    const timeoutMs = Number(process.env.ANALYSIS_TIMEOUT_MS || 30 * 60 * 1000);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      processHandle.kill('SIGTERM');
      setTimeout(() => {
        if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
      }, 5000).unref();
    }, timeoutMs);
    timeout.unref();
    let stderr = '';
    let progressBuffer = '';
    let settled = false;
    processHandle.stdout.on('data', data => {
      progressBuffer += data.toString();
      const lines = progressBuffer.split('\n');
      progressBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('PROGRESS:')) continue;
        const [stepField, pct, msg] = line.split('|');
        void Promise.resolve()
          .then(() => onProgress({
            step: stepField.slice('PROGRESS:'.length),
            pct: Number.parseInt(pct, 10),
            msg,
          }))
          .catch(error => console.error('Analysis progress notification failed:', error));
      }
    });
    processHandle.stderr.on('data', data => { stderr += data.toString(); });
    processHandle.once('error', error => {
      clearTimeout(timeout);
      settled = true;
      reject(new Error(`Unable to start Python analysis (${python}): ${error.message}`));
    });
    processHandle.once('close', code => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (timedOut) reject(new Error(`Analysis exceeded the ${Math.ceil(timeoutMs / 60000)} minute time limit`));
      else if (code === 0) resolve();
      else reject(new Error(stderr || `Python analysis exited with code ${code}`));
    });
  });
}

export async function processAnalysis(analysisId, onProgress = async () => {}) {
  const db = getDB();
  const job = await db.get('SELECT * FROM analyses WHERE id = ?', analysisId);
  if (!job) throw new Error(`Analysis job ${analysisId} was not found`);
  const directory = await mkdtemp(path.join(os.tmpdir(), `ds-agent-${analysisId}-`));
  const inputPath = path.join(directory, path.basename(job.original_name || 'dataset'));
  const outputDirectory = isObjectStorageEnabled()
    ? path.join(directory, 'output')
    : path.join(OUTPUTS_DIR, job.id);
  let temporaryInput = false;

  try {
    const downloaded = await downloadFileToPath(job.file_path, inputPath);
    temporaryInput = downloaded.temporary;
    const actualInputPath = downloaded.path;
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });
    if (isObjectStorageEnabled())
      await deletePrefix(getWorkspaceAnalysisPrefix(job.workspace_id, job.id));
    const jobConfig = JSON.parse(job.config_json || '{}');
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({
      job_id: job.id,
      file_path: actualInputPath,
      output_dir: outputDirectory,
      analysis_type: jobConfig.analysis_type || 'eda',
      target_col: jobConfig.target_col || null,
    }, null, 2));
    await db.run("UPDATE analyses SET status = 'running', error_msg = NULL WHERE id = ?", job.id);
    await onProgress({ step: 'profiling', pct: 10, msg: 'Profiling dataset...' });
    await runPython(configPath, progress => {
      void Promise.resolve()
        .then(() => onProgress(progress))
        .catch(error => console.error('Analysis progress notification failed:', error));
    });

    const result = JSON.parse(await readFile(path.join(outputDirectory, 'result.json'), 'utf8'));
    let outputKey = outputDirectory;
    if (isObjectStorageEnabled()) {
      outputKey = getWorkspaceAnalysisPrefix(job.workspace_id, job.id);
      await uploadDirectory(outputDirectory, outputKey);
    }
    await db.run(`UPDATE analyses SET status = 'completed', output_dir = ?, result_json = ?,
      completed_at = unixepoch() WHERE id = ?`,
    outputKey, JSON.stringify(result), job.id);
    await onProgress({ step: 'complete', pct: 100, msg: 'Analysis complete!' });
    return result;
  } catch (error) {
    const errorMessage = error.message || 'Analysis failed';
    await db.run("UPDATE analyses SET status = 'failed', error_msg = ? WHERE id = ?", errorMessage, job.id);
    await onProgress({ step: 'error', pct: 0, msg: errorMessage });
    if (!isObjectStorageEnabled()) await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    if (temporaryInput && fs.existsSync(inputPath)) await rm(inputPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}
