import { Router } from 'express';
import { query } from '../db.js';
import { HttpError, wrap } from '../utils/http.js';
import { requireUser } from '../middleware/auth.js';
import { notify } from '../services/notifications.js';

const router = Router();
router.use(requireUser);

const PAIR = '(requester_id=$1 and addressee_id=$2) or (requester_id=$2 and addressee_id=$1)';

router.get('/connections/requests', wrap(async (req, res) => {
  const { rows } = await query(
    `select u.id, u.username, u.full_name, u.faculty, u.university, u.avatar_url, c.created_at
     from connections c join users u on u.id = c.requester_id
     where c.addressee_id=$1 and c.status='pending'
     order by c.created_at desc limit 50`,
    [req.user.id],
  );
  res.json({
    requests: rows.map((r) => ({ id: r.id, username: r.username, fullName: r.full_name, faculty: r.faculty, university: r.university, avatarUrl: r.avatar_url || null, createdAt: r.created_at })),
  });
}));

// So'rov yuborish; qarshi tomon allaqachon yuborgan bo'lsa, avtomatik ulanadi
router.post('/connections/:userId', wrap(async (req, res) => {
  const me = req.user.id;
  const other = req.params.userId;
  if (other === me) throw new HttpError(400, 'O‘zingiz bilan ulana olmaysiz');
  const { rows } = await query(`select * from connections where ${PAIR}`, [me, other]);
  const c = rows[0];
  if (c) {
    if (c.status === 'accepted') throw new HttpError(409, 'Siz allaqachon ulangansiz');
    if (c.requester_id === me) throw new HttpError(409, 'So‘rov allaqachon yuborilgan');
    await query(`update connections set status='accepted' where requester_id=$1 and addressee_id=$2`, [other, me]);
    await notify(other, { type: 'connection_accepted', title: `${req.user.full_name} ulanishingizni qabul qildi`, link: `/app/profile/${req.user.username}` });
    return res.json({ status: 'connected' });
  }
  await query(`insert into connections (requester_id, addressee_id, status) values ($1,$2,'pending')`, [me, other]);
  await notify(other, { type: 'connection_request', title: `${req.user.full_name} sizga ulanish so‘rovi yubordi`, link: `/app/profile/${req.user.username}` });
  res.status(201).json({ status: 'pending_out' });
}));

router.post('/connections/:userId/accept', wrap(async (req, res) => {
  const { rowCount } = await query(
    `update connections set status='accepted'
     where requester_id=$2 and addressee_id=$1 and status='pending'`,
    [req.user.id, req.params.userId],
  );
  if (!rowCount) throw new HttpError(404, 'So‘rov topilmadi');
  await notify(req.params.userId, { type: 'connection_accepted', title: `${req.user.full_name} ulanish so‘rovingizni qabul qildi`, link: `/app/profile/${req.user.username}` });
  res.json({ status: 'connected' });
}));

// Bekor qilish, rad etish yoki ulanishni olib tashlash
router.delete('/connections/:userId', wrap(async (req, res) => {
  await query(`delete from connections where ${PAIR}`, [req.user.id, req.params.userId]);
  res.json({ ok: true });
}));

export default router;
