import { Router } from 'express';
import { query } from '../db.js';
import { wrap } from '../utils/http.js';
import { requireUser } from '../middleware/auth.js';

const router = Router();
router.use(requireUser);

router.get('/notifications', wrap(async (req, res) => {
  const { rows } = await query(
    'select * from notifications where user_id=$1 order by created_at desc limit 40',
    [req.user.id],
  );
  const { rows: [c] } = await query(
    'select count(*)::int as unread from notifications where user_id=$1 and read_at is null',
    [req.user.id],
  );
  res.json({
    unread: c.unread,
    notifications: rows.map((n) => ({
      id: n.id, type: n.type, title: n.title, body: n.body, link: n.link,
      createdAt: n.created_at, read: !!n.read_at,
    })),
  });
}));

router.post('/notifications/read', wrap(async (req, res) => {
  await query('update notifications set read_at=now() where user_id=$1 and read_at is null', [req.user.id]);
  res.json({ ok: true });
}));

export default router;
