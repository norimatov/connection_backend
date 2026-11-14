import { Router } from 'express';
import { query } from '../db.js';
import { HttpError, wrap } from '../utils/http.js';
import { publicUser } from '../utils/mapper.js';
import { requireUser } from '../middleware/auth.js';
import { imageUpload, mediaUpload, attachmentUpload, mediaKind, displayName, removeUpload } from '../utils/media.js';

const router = Router();
router.use(requireUser);

/* ---------- Profil rasmi ---------- */
router.post('/me/avatar', imageUpload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Rasm tanlanmadi');
  const old = req.user.avatar_url;
  const { rows } = await query('update users set avatar_url=$2 where id=$1 returning *', [req.user.id, `/uploads/${req.file.filename}`]);
  removeUpload(old);
  res.json({ user: publicUser(rows[0], true) });
}));

router.delete('/me/avatar', wrap(async (req, res) => {
  removeUpload(req.user.avatar_url);
  const { rows } = await query('update users set avatar_url=null where id=$1 returning *', [req.user.id]);
  res.json({ user: publicUser(rows[0], true) });
}));

/* ---------- 24 soatlik hikoyalar (o'zim + ulangan talabalar) ---------- */
router.get('/stories', wrap(async (req, res) => {
  const { rows } = await query(
    `select s.id, s.user_id, s.media_url, s.media_type, s.caption, s.created_at,
            u.username, u.full_name, u.avatar_url
     from stories s join users u on u.id = s.user_id
     where s.expires_at > now()
       and (s.user_id = $1 or s.user_id in (
         select case when c.requester_id = $1 then c.addressee_id else c.requester_id end
         from connections c
         where c.status = 'accepted' and (c.requester_id = $1 or c.addressee_id = $1)
       ))
     order by s.created_at asc`,
    [req.user.id],
  );
  const groups = new Map();
  for (const s of rows) {
    if (!groups.has(s.user_id)) {
      groups.set(s.user_id, {
        user: { id: s.user_id, username: s.username, fullName: s.full_name, avatarUrl: s.avatar_url || null },
        mine: s.user_id === req.user.id,
        stories: [],
      });
    }
    groups.get(s.user_id).stories.push({ id: s.id, mediaUrl: s.media_url, mediaType: s.media_type, caption: s.caption, createdAt: s.created_at });
  }
  const users = [...groups.values()].sort((a, b) => Number(b.mine) - Number(a.mine));
  res.json({ users });
}));

router.post('/stories', mediaUpload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Rasm yoki video tanlang');
  const { rows } = await query(
    `insert into stories (user_id, media_url, media_type, caption, expires_at)
     values ($1,$2,$3,$4, now() + interval '24 hours') returning id`,
    [req.user.id, `/uploads/${req.file.filename}`, mediaKind(req.file.mimetype), String(req.body.caption || '').trim().slice(0, 200)],
  );
  res.status(201).json({ id: rows[0].id });
}));

router.delete('/stories/:id', wrap(async (req, res) => {
  const { rows } = await query('delete from stories where id=$1 and user_id=$2 returning media_url', [req.params.id, req.user.id]);
  if (!rows[0]) throw new HttpError(404, 'Hikoya topilmadi');
  removeUpload(rows[0].media_url);
  res.json({ ok: true });
}));

/* ---------- Guruh chati: superadmin har doim, a'zolar sozlamaga qarab ---------- */
router.post('/groups/:id/media', attachmentUpload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Fayl tanlang');
  const { rows: [m] } = await query(
    `select gm.role, g.members_can_send_media
     from group_members gm join groups g on g.id = gm.group_id
     where gm.group_id=$1 and gm.user_id=$2`,
    [req.params.id, req.user.id],
  );
  const allowed = !!m && (m.role === 'owner' || m.members_can_send_media);
  if (!allowed) {
    removeUpload(`/uploads/${req.file.filename}`);
    throw new HttpError(403, 'Bu guruhda rasm, video yoki fayl yuborish cheklangan');
  }
  const caption = String(req.body.caption || '').trim().slice(0, 1000);
  await query(
    `insert into group_messages (group_id, user_id, body, media_url, media_type, file_name, file_size)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [req.params.id, req.user.id, caption, `/uploads/${req.file.filename}`, mediaKind(req.file.mimetype), displayName(req.file), req.file.size],
  );
  res.status(201).json({ ok: true });
}));

/* ---------- Shaxsiy chat: istalgan rasm, video yoki fayl ---------- */
router.post('/messages/:userId/media', attachmentUpload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Fayl tanlang');
  const url = `/uploads/${req.file.filename}`;
  if (req.params.userId === req.user.id) {
    removeUpload(url);
    throw new HttpError(400, 'O‘zingizga fayl yuborib bo‘lmaydi');
  }
  const caption = String(req.body.caption || '').trim().slice(0, 2000);
  try {
    await query(
      `insert into direct_messages (sender_id, recipient_id, body, media_url, media_type, file_name, file_size)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [req.user.id, req.params.userId, caption, url, mediaKind(req.file.mimetype), displayName(req.file), req.file.size],
    );
  } catch (e) {
    removeUpload(url);
    throw e;
  }
  res.status(201).json({ ok: true });
}));

export default router;
