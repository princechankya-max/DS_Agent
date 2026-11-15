import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, readdir } from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hasObjectStorage = Boolean(
  process.env.OBJECT_STORAGE_ENDPOINT &&
  process.env.OBJECT_STORAGE_BUCKET &&
  process.env.OBJECT_STORAGE_ACCESS_KEY &&
  process.env.OBJECT_STORAGE_SECRET_KEY,
);
const bucket = process.env.OBJECT_STORAGE_BUCKET;
const client = hasObjectStorage ? new S3Client({
  region: process.env.OBJECT_STORAGE_REGION || 'us-east-1',
  endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
  forcePathStyle: process.env.OBJECT_STORAGE_PATH_STYLE !== 'false',
  credentials: {
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY,
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY,
  },
}) : null;

export function isObjectStorageEnabled() {
  return hasObjectStorage;
}

export async function checkObjectStorage() {
  if (!hasObjectStorage) return { status: 'local-fallback' };
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  return { status: 'ok' };
}

export async function ensureObjectStorageBucket() {
  if (!hasObjectStorage) return;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch (error) {
      const missing = error.name === 'NotFound' || error.name === 'NoSuchBucket' ||
        error.$metadata?.httpStatusCode === 404;
      if (missing) {
        try {
          await client.send(new CreateBucketCommand({ Bucket: bucket }));
          return;
        } catch (createError) {
          if (createError.name === 'BucketAlreadyOwnedByYou') return;
          throw createError;
        }
      }
      if (attempt === 29) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

export async function storeFile(localPath, objectKey, contentType = 'application/octet-stream') {
  if (!hasObjectStorage) return localPath;
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: objectKey,
      Body: createReadStream(localPath),
      ContentType: contentType,
      ServerSideEncryption: process.env.OBJECT_STORAGE_SSE || undefined,
    },
    queueSize: 2,
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false,
  });
  await upload.done();
  return objectKey;
}

export async function downloadFileToPath(objectKey, destination) {
  if (!hasObjectStorage) return { path: objectKey, temporary: false };
  await mkdir(path.dirname(destination), { recursive: true });
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  if (!result.Body) throw new Error('Object storage returned an empty file body');
  await pipeline(result.Body, createWriteStream(destination, { flags: 'wx' }));
  return { path: destination, temporary: true };
}

export async function uploadDirectory(localDirectory, prefix) {
  if (!hasObjectStorage) return prefix;
  async function visit(directory, relative = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const localPath = path.join(directory, entry.name);
      const childPath = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await visit(localPath, childPath);
      } else if (entry.isFile()) {
        await storeFile(localPath, path.posix.join(prefix, childPath));
      }
    }
  }
  await visit(localDirectory);
  return prefix;
}

export async function getFileLocation(objectKey, fileName) {
  if (!hasObjectStorage) {
    const localPath = path.resolve(objectKey, fileName);
    const root = path.resolve(objectKey);
    if (!localPath.startsWith(`${root}${path.sep}`)) throw new Error('Invalid stored file path');
    return { type: 'local', path: localPath };
  }
  const key = path.posix.join(objectKey, fileName);
  const url = await getSignedUrl(client, new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${path.basename(fileName).replace(/["\\]/g, '_')}"`,
  }), { expiresIn: 300 });
  return { type: 'redirect', url };
}

export async function deleteObject(objectKey) {
  if (!hasObjectStorage) return;
  await client.send(new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: { Objects: [{ Key: objectKey }], Quiet: true },
  }));
}

export async function deletePrefix(prefix) {
  if (!hasObjectStorage) return;
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    const objects = (page.Contents || []).map(object => ({ Key: object.Key }));
    if (objects.length) {
      await client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects, Quiet: true },
      }));
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
}

export function getWorkspaceUploadKey(workspaceId, fileId, fileName) {
  const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.posix.join('workspaces', workspaceId, 'uploads', fileId, safeName);
}

export function getWorkspaceAnalysisPrefix(workspaceId, analysisId) {
  return path.posix.join('workspaces', workspaceId, 'analyses', analysisId);
}

export function getTemporaryDirectory(name) {
  return path.join(process.env.TEMP_WORK_DIR || path.join(__dirname, '../../tmp'), name);
}
