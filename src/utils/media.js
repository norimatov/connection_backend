import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { query } from '../db.js';
import { HttpError } from './http.js';

export const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const IMAGE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const VIDEO = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };

// Brauzerda bajariladigan yoki saytning o'zida xavfli bo'ladigan turlar taqiqlanadi
const BLOCKED = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.dll', '.jar', '.apk',
  '.js', '.mjs', '.vbs', '.ps1', '.sh', '.php',
  '.html', '.htm', '.xhtml', '.svg', '.xml',
]);

const safeExt = (name) => {
  const e = path.extname(name || '').toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(e) ? e : '';
};

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) =>
    cb(null, crypto.randomBytes(16).toString('hex') + (IMAGE[file.mimetype] || VIDEO[file.mimetype] || safeExt(file.originalname))),
});

// Profil rasmi: faqat rasm, 5 MB gacha
export const imageUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => (IMAGE[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Faqat JPG, PNG, WEBP yoki GIF'))),
});

// Hikoyalar: rasm yoki video, 25 MB gacha
export const mediaUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    (IMAGE[file.mimetype] || VIDEO[file.mimetype]) ? cb(null, true) : cb(new HttpError(400, 'Faqat rasm yoki video')),
});

// Chat fayllari: rasm, video yoki istalgan boshqa fayl, 25 MB gacha
export const attachmentUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    BLOCKED.has(safeExt(file.originalname))
      ? cb(new HttpError(400, 'Bu fayl turi yuborishga ruxsat etilmagan'))
      : cb(null, true),
});

export const mediaKind = (mimetype) => (IMAGE[mimetype] ? 'image' : VIDEO[mimetype] ? 'video' : 'file');

export const displayName = (file) => path.basename(file.originalname || 'fayl').slice(0, 200);

export function removeUpload(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(url))).catch(() => {});
}

// 24 soatdan o'tgan hikoyalarni o'chirish
export async function cleanupExpiredStories() {
  const { rows } = await query('delete from stories where expires_at <= now() returning media_url');
  rows.forEach((r) => removeUpload(r.media_url));
}
