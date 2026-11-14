import { Router } from 'express';
import crypto from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import { HttpError, wrap } from '../utils/http.js';
import { requireUser } from '../middleware/auth.js';

const router = Router();
router.use(requireUser);

router.get('/telegram/status', wrap(async (req, res) => {
  res.json({
    configured: !!config.telegram.username && !!config.telegram.token,
    linked: !!req.user.telegram_chat_id,
    username: req.user.telegram_username || null,
  });
}));

// Bot havolasi: 15 daqiqa amal qiladi
router.post('/telegram/link', wrap(async (req, res) => {
  if (!config.telegram.username || !config.telegram.token) throw new HttpError(503, 'Telegram bot sozlanmagan');
  if (!req.user.phone) throw new HttpError(400, 'Avval telefon raqamingizni qo‘shing (Sozlamalar)');
  await query('delete from telegram_links where user_id=$1', [req.user.id]);
  const token = crypto.randomBytes(16).toString('hex');
  await query(`insert into telegram_links (token, user_id, expires_at) values ($1,$2, now() + interval '15 minutes')`, [token, req.user.id]);
  res.json({ url: `https://t.me/${config.telegram.username}?start=${token}` });
}));

router.delete('/telegram/link', wrap(async (req, res) => {
  await query('update users set telegram_chat_id=null, telegram_username=null where id=$1', [req.user.id]);
  res.json({ ok: true });
}));

export default router;
