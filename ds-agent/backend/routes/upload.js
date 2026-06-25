import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { requireAuth } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// ── Magic Bytes Validation ──
const MAGIC = {
  csv:     { bytes: null, check: (buf) => buf.toString('utf8', 0, 100).includes(',') || true },
  xlsx:    { bytes: [0x50, 0x4B, 0x03, 0x04] },  // PK zip header
  json:    { bytes: null, check: (buf) => ['{', '['].includes(String.fromCharCode(buf[0])) },
  parquet: { bytes: [0x50, 0x41, 0x52, 0x31] },  // PAR1
};

function validateMagicBytes(buffer, ext) {
  const magic = MAGIC[ext];
  if (!magic) return false;
  if (magic.bytes) return magic.bytes.every((b, i) => buffer[i] === b);
  if (magic.check) return magic.check(buffer);
  return true;
}

// ── Multer Config ──
const UPLOADS_DIR = path.join(__dirname, '../../uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.csv', '.xlsx', '.xls', '.json', '.parquet'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`File type ${ext} not supported`));
  },
});

// ── POST /api/upload ──
router.post('/', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const ext = path.extname(req.file.originalname).toLowerCase().slice(1);
  const fileBuffer = fs.readFileSync(req.file.path);

  // Magic bytes check
  if (!validateMagicBytes(fileBuffer, ext === 'xls' ? 'xlsx' : ext)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'File content does not match its extension (magic bytes invalid)' });
  }

  res.json({
    file_id: path.basename(req.file.path),
    original_name: req.file.originalname,
    size: req.file.size,
    path: req.file.path,
    message: 'File uploaded and validated successfully',
  });
});

export default router;
