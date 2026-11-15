import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { closeDB } from '../db/database.js';
import { processAnalysis } from '../services/analysisRunner.js';
import { processAnalysisQuestion } from '../services/analysisQuestions.js';
import { QUEUE_NAME, redisOptions } from '../services/analysisQueue.js';

if (!process.env.REDIS_URL)
  throw new Error('REDIS_URL is required for the analysis worker');

const connection = redisOptions();
const publisher = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const worker = new Worker(QUEUE_NAME, async job => {
  if (job.name === 'ask')
    return processAnalysisQuestion(job.data);
  if (job.name !== 'analyze')
    throw new Error(`Unsupported analysis queue job: ${job.name}`);
  await processAnalysis(job.data.analysisId, async progress => {
    await job.updateProgress(progress);
    await publisher.publish('ds-agent-analysis-progress', JSON.stringify({
      jobId: job.data.analysisId,
      ...progress,
    }));
  });
}, {
  connection,
  concurrency: Number(process.env.ANALYSIS_WORKER_CONCURRENCY || 2),
  lockDuration: 10 * 60 * 1000,
});

worker.on('failed', (job, error) => {
  console.error(`Analysis job ${job?.id || 'unknown'} failed:`, error);
});
worker.on('error', error => console.error('Analysis queue worker error:', error));

await worker.waitUntilReady();
console.log(`✓ Analysis worker ready (concurrency ${worker.opts.concurrency})`);

async function shutdown() {
  await worker.close();
  await publisher.quit();
  await closeDB();
}

process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
