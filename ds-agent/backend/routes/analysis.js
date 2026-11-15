import express from 'express';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { requireAuth } from '../middleware/auth.js';
import { getDB } from '../db/database.js';
import { getPlanEntitlements } from '../services/planEntitlements.js';
import { processAnalysis } from '../services/analysisRunner.js';
import { isAIAnalystConfigured } from '../services/aiAnalyst.js';
import {
  enqueueAnalysis,
  enqueueAnalysisQuestion,
  getAnalysisQueueJob,
  hasDurableAnalysisQueue,
} from '../services/analysisQueue.js';
import { deleteObject, deletePrefix, getFileLocation, isObjectStorageEnabled } from '../services/storage.js';
import { io } from '../server.js';

const router = express.Router();
const analystQuestionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

function emitProgress(jobId, progress) {
  io.to(`job-${jobId}`).emit('progress', { ...progress, ts: Date.now() });
}

router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, file_id: fileId, analysis_type: analysisType, target_col: targetCol } = req.body;
    const selectedAnalysisType = analysisType || 'eda';
    if (!['eda', 'eda_ml', 'full'].includes(selectedAnalysisType))
      return res.status(400).json({ error: 'Unsupported analysis type' });
    if (targetCol != null && typeof targetCol !== 'string')
      return res.status(400).json({ error: 'target_col must be a string' });
    if (['eda_ml', 'full'].includes(selectedAnalysisType) && !targetCol?.trim())
      return res.status(400).json({ error: 'target_col is required for machine learning analysis' });
    if (typeof fileId !== 'string' || !/^[0-9a-f-]{36}$/i.test(fileId))
      return res.status(400).json({ error: 'Valid file_id required' });

    const db = getDB();
    const id = uuidv4();
    const config = { analysis_type: selectedAnalysisType, target_col: targetCol || null };
    const reservation = await db.transaction(async transaction => {
      await transaction.lockWorkspace(req.workspace.id);
      const uploadedFile = await transaction.get(`SELECT object_key, original_name, file_size FROM uploaded_files
        WHERE id = ? AND workspace_id = ?`, fileId, req.workspace.id);
      if (!uploadedFile) return { notFound: true };

      const usage = await getPlanEntitlements(transaction, req.workspace.id);
      if (usage.used >= usage.limit) return { quota: usage };

      await transaction.run(`INSERT INTO analyses
        (id, workspace_id, user_id, name, file_path, original_name, file_size, config_json, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
      id,
      req.workspace.id,
      req.user.id,
      name || uploadedFile.original_name || 'Untitled',
      uploadedFile.object_key,
      uploadedFile.original_name,
      uploadedFile.file_size,
      JSON.stringify(config));
      return { queued: true };
    });
    if (reservation.notFound)
      return res.status(404).json({ error: 'Uploaded file not found in this workspace' });
    if (reservation.quota) {
      const { used, plan } = reservation.quota;
      return res.status(429).json({
        error: 'Monthly analysis limit reached for your current plan',
        code: 'ANALYSIS_QUOTA_EXCEEDED',
        used,
        limit: reservation.quota.limit,
        upgrade_required: plan.code !== 'business',
      });
    }

    if (hasDurableAnalysisQueue()) {
      try {
        await enqueueAnalysis(id);
      } catch (error) {
        await db.run("UPDATE analyses SET status = 'failed', error_msg = ? WHERE id = ?", error.message, id);
        console.error('Analysis queue submission failed:', error);
        return res.status(503).json({ error: 'Analysis queue is unavailable; please retry shortly' });
      }
    } else {
      processAnalysis(id, progress => emitProgress(id, progress))
        .catch(error => console.error(`Analysis ${id} failed:`, error));
    }

    return res.status(202).json({ job_id: id, status: 'queued', message: 'Analysis queued' });
  } catch (error) {
    console.error('Could not create analysis:', error);
    return res.status(500).json({ error: 'Could not create analysis' });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const analyses = await getDB().all(`SELECT id, name, status, original_name, file_size, created_at, completed_at
      FROM analyses WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50`, req.workspace.id);
    return res.json({ analyses });
  } catch (error) {
    console.error('Could not list analyses:', error);
    return res.status(500).json({ error: 'Could not list analyses' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const analysis = await getDB().get('SELECT * FROM analyses WHERE id = ? AND workspace_id = ?',
      req.params.id, req.workspace.id);
    if (!analysis) return res.status(404).json({ error: 'Analysis not found' });
    const result = analysis.result_json ? JSON.parse(analysis.result_json) : null;
    return res.json({ ...analysis, result });
  } catch (error) {
    console.error('Could not load analysis:', error);
    return res.status(500).json({ error: 'Could not load analysis' });
  }
});

router.post('/:id/questions', requireAuth, analystQuestionLimiter, async (req, res) => {
  const question = req.body?.question;
  if (typeof question !== 'string' || question.trim().length < 5 || question.length > 1000)
    return res.status(400).json({ error: 'Question must contain 5 to 1000 characters' });
  if (req.body?.data_consent !== true)
    return res.status(400).json({ error: 'Consent is required to send aggregate results to the configured AI provider' });

  try {
    const analysis = await getDB().get(`SELECT id, status, output_dir, result_json FROM analyses
      WHERE id = ? AND workspace_id = ?`, req.params.id, req.workspace.id);
    if (!analysis) return res.status(404).json({ error: 'Analysis not found' });
    if (analysis.status !== 'completed' || !analysis.output_dir || !analysis.result_json)
      return res.status(409).json({ error: 'AI Analyst requires a completed analysis' });
    if (!hasDurableAnalysisQueue())
      return res.status(503).json({ error: 'AI Analyst requires the Redis-backed worker' });
    if (!isAIAnalystConfigured())
      return res.status(503).json({ error: 'AI Analyst is not configured on this server' });

    const questionJobId = `ask-${uuidv4()}`;
    await enqueueAnalysisQuestion({
      questionJobId,
      analysisId: analysis.id,
      workspaceId: req.workspace.id,
      requesterUserId: req.user.id,
      question: question.trim(),
    });
    return res.status(202).json({ job_id: questionJobId, status: 'queued' });
  } catch (error) {
    console.error('Could not queue AI Analyst question:', error);
    return res.status(503).json({ error: 'AI Analyst queue is unavailable; please retry shortly' });
  }
});

router.get('/:id/questions/:questionJobId', requireAuth, async (req, res) => {
  try {
    const analysis = await getDB().get('SELECT id FROM analyses WHERE id = ? AND workspace_id = ?',
      req.params.id, req.workspace.id);
    if (!analysis) return res.status(404).json({ error: 'Analysis not found' });

    if (!/^ask-[0-9a-f-]{36}$/i.test(req.params.questionJobId))
      return res.status(404).json({ error: 'AI Analyst question not found' });
    const job = await getAnalysisQueueJob(req.params.questionJobId);
    if (
      !job ||
      job.data.analysisId !== analysis.id ||
      job.data.workspaceId !== req.workspace.id
    ) return res.status(404).json({ error: 'AI Analyst question not found' });

    const state = await job.getState();
    if (state === 'completed')
      return res.json({ job_id: job.id, status: state, result: job.returnvalue });
    if (state === 'failed')
      return res.json({
        job_id: job.id,
        status: state,
        error: 'AI Analyst could not answer this question; please try again.',
      });
    return res.json({
      job_id: job.id,
      status: state === 'active' ? 'running' : 'queued',
    });
  } catch (error) {
    console.error('Could not load AI Analyst question:', error);
    return res.status(500).json({ error: 'Could not load AI Analyst question' });
  }
});

async function sendStoredFile(res, outputPrefix, fileName) {
  const location = await getFileLocation(outputPrefix, fileName);
  if (location.type === 'redirect') return res.redirect(302, location.url);
  if (!fs.existsSync(location.path)) return res.status(404).json({ error: 'File not generated yet' });
  return res.download(location.path);
}

router.get('/:id/download/:file', requireAuth, async (req, res) => {
  try {
    const analysis = await getDB().get('SELECT output_dir FROM analyses WHERE id = ? AND workspace_id = ?',
      req.params.id, req.workspace.id);
    if (!analysis) return res.status(404).json({ error: 'Not found' });
    if (!analysis.output_dir) return res.status(404).json({ error: 'File not generated yet' });
    const safeFile = path.basename(req.params.file);
    if (safeFile !== req.params.file) return res.status(400).json({ error: 'Invalid file name' });
    return await sendStoredFile(res, analysis.output_dir, safeFile);
  } catch (error) {
    console.error('Could not download analysis output:', error);
    return res.status(500).json({ error: 'Could not download analysis output' });
  }
});

router.get('/:id/visualizations/:file', requireAuth, async (req, res) => {
  try {
    const analysis = await getDB().get('SELECT output_dir FROM analyses WHERE id = ? AND workspace_id = ?',
      req.params.id, req.workspace.id);
    if (!analysis) return res.status(404).json({ error: 'Not found' });
    if (!analysis.output_dir) return res.status(404).json({ error: 'Visualization not generated yet' });
    const file = path.basename(req.params.file);
    if (file !== req.params.file) return res.status(400).json({ error: 'Invalid file name' });
    return await sendStoredFile(res, analysis.output_dir, path.posix.join('visualizations', file));
  } catch (error) {
    console.error('Could not download visualization:', error);
    return res.status(500).json({ error: 'Could not download visualization' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const db = getDB();
    const analysis = await db.get(
      'SELECT output_dir, file_path FROM analyses WHERE id = ? AND workspace_id = ?',
      req.params.id,
      req.workspace.id,
    );
    if (!analysis) return res.status(404).json({ error: 'Not found' });

    if (analysis.output_dir) {
      if (isObjectStorageEnabled()) await deletePrefix(analysis.output_dir);
      else if (fs.existsSync(analysis.output_dir))
        fs.rmSync(analysis.output_dir, { recursive: true, force: true });
    }
    await db.run('DELETE FROM analyses WHERE id = ? AND workspace_id = ?', req.params.id, req.workspace.id);
    const remaining = await db.get('SELECT COUNT(*) AS count FROM analyses WHERE file_path = ?', analysis.file_path);
    if (Number(remaining.count) === 0) {
      if (isObjectStorageEnabled()) await deleteObject(analysis.file_path);
      else if (analysis.file_path && fs.existsSync(analysis.file_path)) fs.unlinkSync(analysis.file_path);
      await db.run('DELETE FROM uploaded_files WHERE object_key = ?', analysis.file_path);
    }
    return res.json({ message: 'Deleted' });
  } catch (error) {
    console.error('Could not delete analysis:', error);
    return res.status(500).json({ error: 'Could not delete analysis' });
  }
});

export default router;
