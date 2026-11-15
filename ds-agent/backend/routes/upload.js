import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { requireAuth } from '../middleware/auth.js';
import { getDB } from '../db/database.js';
import {
  deleteObject,
  getWorkspaceUploadKey,
  isObjectStorageEnabled,
  storeFile,
} from '../services/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../../uploads');

const MAGIC = {
  csv: { check: buffer => buffer.length > 0 && !buffer.includes(0) },
  xlsx: { bytes: [0x50, 0x4B, 0x03, 0x04] },
  xls: { bytes: [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] },
  json: { check: buffer => ['{', '['].includes(buffer.toString('utf8').replace(/^\uFEFF/, '').trim()[0]) },
  parquet: { bytes: [0x50, 0x41, 0x52, 0x31] },
};

function validateMagicBytes(buffer, ext) {
  const magic = MAGIC[ext];
  if (!magic) return false;
  if (magic.bytes) return buffer.length >= magic.bytes.length && magic.bytes.every((byte, index) => buffer[index] === byte);
  return magic.check ? magic.check(buffer) : false;
}

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, callback) => {
    const userDirectory = path.join(UPLOADS_DIR, req.user.id);
    fs.mkdir(userDirectory, { recursive: true }, error => callback(error, userDirectory));
  },
  filename: (req, file, callback) => {
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    callback(null, `${Date.now()}-${uuidv4()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const allowed = ['.csv', '.xlsx', '.xls', '.json', '.parquet'];
    const extension = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(extension)) callback(null, true);
    else callback(new Error(`File type ${extension} not supported`));
  },
});

router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let descriptor;
  try {
    const extension = path.extname(req.file.originalname).toLowerCase().slice(1);
    const buffer = Buffer.alloc(8192);
    const descriptorHandle = fs.openSync(req.file.path, 'r');
    let bytesRead;
    try {
      bytesRead = fs.readSync(descriptorHandle, buffer, 0, buffer.length, 0);
    } finally {
      fs.closeSync(descriptorHandle);
    }
    if (!validateMagicBytes(buffer.subarray(0, bytesRead), extension)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'File content does not match its extension (magic bytes invalid)' });
    }

    const fileId = uuidv4();
    const objectKey = getWorkspaceUploadKey(req.workspace.id, fileId, req.file.originalname);
    const persistedKey = await storeFile(req.file.path, objectKey);
    descriptor = persistedKey;
    const storedName = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    const db = getDB();
    await db.run(`INSERT INTO uploaded_files
      (id, workspace_id, user_id, object_key, original_name, file_size)
      VALUES (?, ?, ?, ?, ?, ?)`,
    fileId, req.workspace.id, req.user.id, persistedKey, storedName, req.file.size);

    if (isObjectStorageEnabled()) fs.unlinkSync(req.file.path);
    return res.json({
      file_id: fileId,
      original_name: req.file.originalname,
      size: req.file.size,
      message: 'File uploaded and validated successfully',
    });
  } catch (error) {
    if (descriptor && isObjectStorageEnabled()) {
      try {
        await deleteObject(descriptor);
      } catch (cleanupError) {
        console.error('Could not clean up failed upload:', cleanupError);
      }
    }
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error('Dataset upload failed:', error);
    return res.status(500).json({ error: 'Could not store uploaded dataset' });
  }
});

router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({
      error: error.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 100MB limit' : error.message,
    });
  }
  if (error) return res.status(400).json({ error: error.message || 'Upload failed' });
  return next();
});

export default router;
