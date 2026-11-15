import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const QUEUE_NAME = 'ds-agent-analysis';
const redisUrl = process.env.REDIS_URL;
let queue;
let progressSubscriber;

function redisOptions() {
  const parsed = new URL(redisUrl);
  const options = {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
  if (parsed.password) options.password = decodeURIComponent(parsed.password);
  const database = parsed.pathname.slice(1);
  if (database) options.db = Number(database);
  if (parsed.protocol === 'rediss:') options.tls = {};
  return options;
}

export function hasDurableAnalysisQueue() {
  return Boolean(redisUrl);
}

export function getAnalysisQueue() {
  if (!redisUrl) return null;
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: redisOptions() });
  return queue;
}

export async function enqueueAnalysis(analysisId) {
  const analysisQueue = getAnalysisQueue();
  if (!analysisQueue) return false;
  await analysisQueue.add('analyze', { analysisId }, {
    jobId: analysisId,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: { age: 604800, count: 5000 },
  });
  return true;
}

export async function enqueueAnalysisQuestion(questionJob) {
  const analysisQueue = getAnalysisQueue();
  if (!analysisQueue) throw new Error('AI Analyst requires a Redis-backed worker');
  await analysisQueue.add('ask', questionJob, {
    jobId: questionJob.questionJobId,
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: { age: 86400, count: 1000 },
  });
}

export async function getAnalysisQueueJob(jobId) {
  const analysisQueue = getAnalysisQueue();
  return analysisQueue ? analysisQueue.getJob(jobId) : null;
}

export async function checkAnalysisQueue() {
  if (!redisUrl) return { status: 'local-fallback' };
  await getAnalysisQueue().getJobCounts();
  return { status: 'ok' };
}

export async function startAnalysisProgressSubscriber(io) {
  if (!redisUrl) return null;
  progressSubscriber = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  await progressSubscriber.ping();
  await progressSubscriber.subscribe('ds-agent-analysis-progress');
  progressSubscriber.on('message', (channel, message) => {
    if (channel !== 'ds-agent-analysis-progress') return;
    try {
      const progress = JSON.parse(message);
      if (typeof progress.jobId === 'string')
        io.to(`job-${progress.jobId}`).emit('progress', progress);
    } catch (error) {
      console.error('Ignoring malformed analysis progress message:', error);
    }
  });
  return progressSubscriber;
}

export async function closeAnalysisQueue() {
  if (progressSubscriber) await progressSubscriber.quit();
  if (queue) await queue.close();
  progressSubscriber = null;
  queue = null;
}

export { QUEUE_NAME, redisOptions };
