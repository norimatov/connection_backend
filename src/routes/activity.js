import { Router } from 'express';
import { query } from '../db.js';
import { wrap } from '../utils/http.js';
import { requireUser } from '../middleware/auth.js';

const router = Router();
router.use(requireUser);

// Yangi xabar va bildirishnomalar soni
router.get('/activity', wrap(async (req, res) => {
  const me = req.user.id;
  const { rows: [dm] } = await query(
    `select count(*)::int as n from direct_messages m
     where m.recipient_id = $1
       and m.created_at > coalesce(
         (select r.read_at from chat_reads r where r.user_id=$1 and r.kind='dm' and r.target_id=m.sender_id),
         'epoch'::timestamptz)`,
    [me],
  );
  const { rows: [grp] } = await query(
    `select count(*)::int as n from group_messages m
     join group_members gm on gm.group_id = m.group_id and gm.user_id = $1
     where m.user_id <> $1
       and m.created_at > coalesce(
         (select r.read_at from chat_reads r where r.user_id=$1 and r.kind='group' and r.target_id=m.group_id),
         'epoch'::timestamptz)`,
    [me],
  );
  const { rows: [nt] } = await query(
    'select count(*)::int as n from notifications where user_id=$1 and read_at is null',
    [me],
  );
  const { rows: [latest] } = await query(
    `select u.full_name, m.body from direct_messages m
     join users u on u.id = m.sender_id
     where m.recipient_id = $1
       and m.created_at > coalesce(
         (select r.read_at from chat_reads r where r.user_id=$1 and r.kind='dm' and r.target_id=m.sender_id),
         'epoch'::timestamptz)
     order by m.created_at desc limit 1`,
    [me],
  );
  res.json({
    dm: dm.n,
    group: grp.n,
    notifications: nt.n,
    latestFrom: latest?.full_name || null,
    latestPreview: (latest?.body || '').slice(0, 80),
  });
}));

export default router;
