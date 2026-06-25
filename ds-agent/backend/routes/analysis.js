import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { requireAuth } from '../middleware/auth.js';
import { getDB } from '../db/database.js';
import { io } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();
const OUTPUTS_DIR = path.join(__dirname, '../../outputs');
if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

// ── Emit progress to socket ──
function emitProgress(jobId, step, pct, msg) {
  io.to(`job-${jobId}`).emit('progress', { step, pct, msg, ts: Date.now() });
}

// ── Run Python Analysis ──
async function runAnalysis(job) {
  const db = getDB();
  const outDir = path.join(OUTPUTS_DIR, job.id);
  fs.mkdirSync(outDir, { recursive: true });

  const config = {
    job_id: job.id,
    file_path: job.file_path,
    output_dir: outDir,
    analysis_type: JSON.parse(job.config_json || '{}').analysis_type || 'eda',
    target_col: JSON.parse(job.config_json || '{}').target_col || null,
  };

  const configPath = path.join(outDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  db.prepare('UPDATE analyses SET status = ?, output_dir = ? WHERE id = ?').run('running', outDir, job.id);
  emitProgress(job.id, 'profiling', 10, 'Profiling dataset...');

  return new Promise((resolve, reject) => {
    const enginePath = path.join(__dirname, '../../analysis_engine.py');
    const py = spawn('python3', [enginePath, '--config', configPath]);

    let stdout = '', stderr = '';
    py.stdout.on('data', (d) => {
      stdout += d.toString();
      // Parse progress lines
      const lines = d.toString().split('\n');
      lines.forEach(line => {
        if (line.startsWith('PROGRESS:')) {
          const [, step, pct, msg] = line.split('|');
          emitProgress(job.id, step, parseInt(pct), msg);
        }
      });
    });
    py.stderr.on('data', (d) => { stderr += d.toString(); });

    py.on('close', (code) => {
      if (code === 0) {
        try {
          const resultPath = path.join(outDir, 'result.json');
          const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
          db.prepare('UPDATE analyses SET status = ?, result_json = ?, completed_at = unixepoch() WHERE id = ?')
            .run('completed', JSON.stringify(result), job.id);
          emitProgress(job.id, 'complete', 100, 'Analysis complete!');
          resolve(result);
        } catch (e) {
          db.prepare('UPDATE analyses SET status = ?, error_msg = ? WHERE id = ?').run('failed', e.message, job.id);
          reject(e);
        }
      } else {
        const errMsg = stderr || 'Python analysis failed';
        db.prepare('UPDATE analyses SET status = ?, error_msg = ? WHERE id = ?').run('failed', errMsg, job.id);
        emitProgress(job.id, 'error', 0, errMsg);
        reject(new Error(errMsg));
      }
    });
  });
}

// ── POST /api/analysis — Create job ──
router.post('/', requireAuth, (req, res) => {
  const { name, file_path, original_name, file_size, analysis_type, target_col } = req.body;
  if (!file_path) return res.status(400).json({ error: 'file_path required' });

  const db = getDB();
  const id = uuidv4();
  const config = { analysis_type: analysis_type || 'eda', target_col };

  db.prepare(`INSERT INTO analyses (id, user_id, name, file_path, original_name, file_size, config_json, status)
    VALUES (?,?,?,?,?,?,?,'queued')`)
    .run(id, req.user.id, name || original_name || 'Untitled', file_path, original_name, file_size, JSON.stringify(config));

  res.json({ job_id: id, status: 'queued', message: 'Analysis queued' });

  // Run async (non-blocking)
  const job = db.prepare('SELECT * FROM analyses WHERE id = ?').get(id);
  runAnalysis(job).catch(err => console.error('Analysis error:', err));
});

// ── GET /api/analysis — List user's analyses ──
router.get('/', requireAuth, (req, res) => {
  const db = getDB();
  const analyses = db.prepare(
    'SELECT id, name, status, original_name, file_size, created_at, completed_at FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.user.id);
  res.json({ analyses });
});

// ── GET /api/analysis/:id — Get one analysis ──
router.get('/:id', requireAuth, (req, res) => {
  const db = getDB();
  const analysis = db.prepare('SELECT * FROM analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!analysis) return res.status(404).json({ error: 'Analysis not found' });

  const result = analysis.result_json ? JSON.parse(analysis.result_json) : null;
  res.json({ ...analysis, result });
});

// ── GET /api/analysis/:id/download/:file — Download output file ──
router.get('/:id/download/:file', requireAuth, (req, res) => {
  const db = getDB();
  const analysis = db.prepare('SELECT output_dir FROM analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!analysis) return res.status(404).json({ error: 'Not found' });

  const safeFile = req.params.file.replace(/\.\./g, '');
  const filePath = path.join(analysis.output_dir, safeFile);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not generated yet' });

  res.download(filePath);
});

// ── DELETE /api/analysis/:id ──
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDB();
  const analysis = db.prepare('SELECT output_dir FROM analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!analysis) return res.status(404).json({ error: 'Not found' });

  if (analysis.output_dir && fs.existsSync(analysis.output_dir))
    fs.rmSync(analysis.output_dir, { recursive: true, force: true });

  db.prepare('DELETE FROM analyses WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

export default router;
