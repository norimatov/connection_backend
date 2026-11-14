import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query } from '../db.js';
import { HttpError, wrap } from '../utils/http.js';
import { requireUser, requireVerified } from '../middleware/auth.js';
import { notify } from '../services/notifications.js';

const router = Router();
const guard = [requireUser];
const KINDS = ['post', 'announcement', 'job', 'service'];

const mapPost = (r) => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  body: r.body,
  createdAt: r.created_at,
  likes: r.likes,
  comments: r.comments,
  liked: r.liked,
  author: { id: r.author_id, username: r.username, fullName: r.full_name, faculty: r.faculty, avatarUrl: r.avatar_url || null },
});

async function assertMember(groupId, userId) {
  const { rowCount } = await query('select 1 from group_members where group_id=$1 and user_id=$2', [groupId, userId]);
  if (!rowCount) throw new HttpError(403, 'Avval guruhga qo‘shiling');
}

/* ---------- Feed ---------- */
router.get('/posts', ...guard, wrap(async (req, res) => {
  const kind = z.enum(['all', ...KINDS]).catch('all').parse(req.query.kind);
  const d = req.query.before ? new Date(String(req.query.before)) : null;
  const before = d && !isNaN(d) ? d.toISOString() : null;
  const { rows } = await query(
    `select p.id, p.kind, p.title, p.body, p.created_at,
            u.id as author_id, u.username, u.full_name, u.faculty, u.avatar_url,
            (select count(*) from post_likes l where l.post_id = p.id)::int as likes,
            (select count(*) from comments c where c.post_id = p.id)::int as comments,
            exists(select 1 from post_likes l where l.post_id = p.id and l.user_id = $1) as liked
     from posts p join users u on u.id = p.user_id
     where ($2::text = 'all' or p.kind = $2::text)
       and ($3::timestamptz is null or p.created_at < $3::timestamptz)
     order by p.created_at desc limit 20`,
    [req.user.id, kind, before],
  );
  res.json({ posts: rows.map(mapPost) });
}));

router.post('/posts', ...guard, wrap(async (req, res) => {
  const d = z.object({
    kind: z.enum(KINDS),
    title: z.string().trim().max(120).default(''),
    body: z.string().trim().min(1, 'Matn bo‘sh bo‘lmasligi kerak').max(3000),
  }).parse(req.body);
  const { rows } = await query(
    'insert into posts (user_id, kind, title, body) values ($1,$2,$3,$4) returning id',
    [req.user.id, d.kind, d.title, d.body],
  );
  res.status(201).json({ id: rows[0].id });
}));

router.delete('/posts/:id', ...guard, wrap(async (req, res) => {
  const { rowCount } = await query('delete from posts where id=$1 and user_id=$2', [req.params.id, req.user.id]);
  if (!rowCount) throw new HttpError(404, 'Post topilmadi yoki ruxsat yo‘q');
  res.json({ ok: true });
}));

router.post('/posts/:id/like', ...guard, wrap(async (req, res) => {
  const { rowCount } = await query('delete from post_likes where post_id=$1 and user_id=$2', [req.params.id, req.user.id]);
  if (rowCount) return res.json({ liked: false });
  await query('insert into post_likes (post_id, user_id) values ($1,$2) on conflict do nothing', [req.params.id, req.user.id]);
  res.json({ liked: true });
}));

router.get('/posts/:id/comments', ...guard, wrap(async (req, res) => {
  const { rows } = await query(
    `select c.id, c.body, c.created_at, u.id as user_id, u.username, u.full_name, u.avatar_url
     from comments c join users u on u.id = c.user_id
     where c.post_id=$1 order by c.created_at asc limit 200`,
    [req.params.id],
  );
  res.json({
    comments: rows.map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.created_at,
      author: { id: c.user_id, username: c.username, fullName: c.full_name, avatarUrl: c.avatar_url || null },
    })),
  });
}));

router.post('/posts/:id/comments', ...guard, wrap(async (req, res) => {
  const { body } = z.object({ body: z.string().trim().min(1).max(1000) }).parse(req.body);
  await query('insert into comments (post_id, user_id, body) values ($1,$2,$3)', [req.params.id, req.user.id, body]);
  res.status(201).json({ ok: true });
}));

/* ---------- Groups ---------- */
const newInvite = () => crypto.randomBytes(6).toString('hex');

async function findGroup(id) {
  const { rows } = await query('select * from groups where id=$1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Guruh topilmadi');
  return rows[0];
}

async function membershipOf(groupId, userId) {
  const { rows } = await query('select * from group_members where group_id=$1 and user_id=$2', [groupId, userId]);
  return rows[0] || null;
}

const isOwnerM = (m) => !!m && m.role === 'owner';
const canEditM = (m) => !!m && (m.role === 'owner' || !!m.can_edit);
const canApproveM = (m) => !!m && (m.role === 'owner' || !!m.can_approve);
const canRemoveM = (m) => !!m && (m.role === 'owner' || !!m.can_remove);
function need(ok, msg) {
  if (!ok) throw new HttpError(403, msg || 'Ruxsat yo‘q');
}

// Guruh boshqaruvchilariga (superadmin va huquqli adminlarga) xabar
async function notifyManagers(groupId, payload, exceptUserId) {
  const { rows } = await query(
    `select user_id from group_members where group_id=$1 and (role='owner' or can_approve)`,
    [groupId],
  );
  for (const r of rows) {
    if (r.user_id !== exceptUserId) await notify(r.user_id, payload);
  }
}

router.get('/groups', ...guard, wrap(async (req, res) => {
  const { rows } = await query(
    `select g.id, g.name, g.description, g.created_at, g.is_private, g.visibility, g.invite_code, g.members_can_send_media,
            (select count(*) from group_members x where x.group_id = g.id)::int as members,
            m.role as my_role, m.can_remove, m.can_approve, m.can_edit,
            exists(select 1 from group_requests r where r.group_id = g.id and r.user_id = $1) as requested,
            (select b.body from group_messages b where b.group_id = g.id order by b.created_at desc limit 1) as last_body,
            (select max(b.created_at) from group_messages b where b.group_id = g.id) as last_at
     from groups g
     left join group_members m on m.group_id = g.id and m.user_id = $1
     where g.visibility = 'public' or m.user_id is not null
     order by coalesce((select max(b.created_at) from group_messages b where b.group_id = g.id), g.created_at) desc
     limit 100`,
    [req.user.id],
  );
  res.json({
    groups: rows.map((g) => {
      const mm = { role: g.my_role, can_remove: g.can_remove, can_approve: g.can_approve, can_edit: g.can_edit };
      return {
        id: g.id, name: g.name, description: g.description, members: g.members,
        joined: !!g.my_role, requested: g.requested, isPrivate: g.is_private, visibility: g.visibility,
        membersCanSendMedia: g.members_can_send_media,
        myRole: g.my_role || null,
        isOwner: isOwnerM(mm), canEdit: canEditM(mm), canApprove: canApproveM(mm), canRemove: canRemoveM(mm),
        inviteCode: canEditM(mm) ? g.invite_code : null,
        createdAt: g.created_at, lastBody: g.last_body, lastAt: g.last_at,
      };
    }),
  });
}));

router.post('/groups', ...guard, wrap(async (req, res) => {
  const d = z.object({
    name: z.string().trim().min(3, 'Guruh nomi kamida 3 belgi').max(80),
    description: z.string().trim().max(300).default(''),
    isPrivate: z.boolean().default(false),
    visibility: z.enum(['public', 'private']).default('public'),
  }).parse(req.body);
  const { rows } = await query(
    `insert into groups (name, description, created_by, is_private, visibility, invite_code)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [d.name, d.description, req.user.id, d.isPrivate, d.visibility, newInvite()],
  );
  await query(
    `insert into group_members (group_id, user_id, role, can_remove, can_approve, can_edit)
     values ($1,$2,'owner',true,true,true)`,
    [rows[0].id, req.user.id],
  );
  res.status(201).json({ id: rows[0].id });
}));

router.patch('/groups/:id', ...guard, wrap(async (req, res) => {
  const g = await findGroup(req.params.id);
  need(canEditM(await membershipOf(g.id, req.user.id)), 'Guruh sozlamalarini o‘zgartirish huquqi yo‘q');
  const d = z.object({
    name: z.string().trim().min(3, 'Guruh nomi kamida 3 belgi').max(80).optional(),
    description: z.string().trim().max(300).optional(),
    isPrivate: z.boolean().optional(),
    visibility: z.enum(['public', 'private']).optional(),
    membersCanSendMedia: z.boolean().optional(),
  }).parse(req.body);
  await query(
    `update groups set
       name = coalesce($2, name),
       description = coalesce($3, description),
       is_private = coalesce($4, is_private),
       visibility = coalesce($5, visibility),
       members_can_send_media = coalesce($6, members_can_send_media)
     where id=$1`,
    [g.id, d.name ?? null, d.description ?? null, d.isPrivate ?? null, d.visibility ?? null, d.membersCanSendMedia ?? null],
  );
  res.json({ ok: true });
}));

router.post('/groups/:id/invite/reset', ...guard, wrap(async (req, res) => {
  const g = await findGroup(req.params.id);
  need(canEditM(await membershipOf(g.id, req.user.id)), 'Havolani yangilash huquqi yo‘q');
  const code = newInvite();
  await query('update groups set invite_code=$2 where id=$1', [g.id, code]);
  res.json({ inviteCode: code });
}));

router.get('/groups/:id/members', ...guard, wrap(async (req, res) => {
  await assertMember(req.params.id, req.user.id);
  const { rows } = await query(
    `select u.id, u.username, u.full_name, u.faculty, u.avatar_url, gm.role, gm.can_remove, gm.can_approve, gm.can_edit, gm.joined_at
     from group_members gm join users u on u.id = gm.user_id
     where gm.group_id = $1
     order by case gm.role when 'owner' then 0 when 'admin' then 1 else 2 end, gm.joined_at asc
     limit 300`,
    [req.params.id],
  );
  res.json({
    members: rows.map((m) => ({
      id: m.id, username: m.username, fullName: m.full_name, faculty: m.faculty, avatarUrl: m.avatar_url || null, role: m.role,
      canRemove: m.can_remove, canApprove: m.can_approve, canEdit: m.can_edit, joinedAt: m.joined_at,
    })),
  });
}));

// Superadmin: a'zoni admin qiladi yoki adminlikdan oladi, admin huquqlarini belgilaydi
router.patch('/groups/:id/members/:userId', ...guard, wrap(async (req, res) => {
  const g = await findGroup(req.params.id);
  need(isOwnerM(await membershipOf(g.id, req.user.id)), 'Faqat superadmin admin tayinlay oladi');
  const target = await membershipOf(g.id, req.params.userId);
  if (!target) throw new HttpError(404, 'A‘zo topilmadi');
  if (target.role === 'owner') throw new HttpError(400, 'Superadmin rolini o‘zgartirib bo‘lmaydi');
  const d = z.object({
    role: z.enum(['admin', 'member']).optional(),
    canRemove: z.boolean().optional(),
    canApprove: z.boolean().optional(),
    canEdit: z.boolean().optional(),
  }).parse(req.body);
  const role = d.role ?? target.role;
  const isAdmin = role === 'admin';
  // Huquqlar faqat admin uchun amal qiladi
  const perm = (val, cur) => (isAdmin ? (val ?? !!cur) : false);
  await query(
    `update group_members set role=$3, can_remove=$4, can_approve=$5, can_edit=$6
     where group_id=$1 and user_id=$2`,
    [g.id, req.params.userId, role, perm(d.canRemove, target.can_remove), perm(d.canApprove, target.can_approve), perm(d.canEdit, target.can_edit)],
  );
  if (d.role && d.role !== target.role) {
    await notify(req.params.userId, {
      type: 'group_role',
      title: role === 'admin' ? `«${g.name}» guruhida admin etib tayinlandingiz` : `«${g.name}» guruhida adminlik olib tashlandi`,
      link: `/app/groups?g=${g.id}`,
    });
  }
  res.json({ ok: true });
}));

// A'zoni guruhdan chiqarish: superadmin istalganini, huquqli admin faqat oddiy a'zolarni
router.delete('/groups/:id/members/:userId', ...guard, wrap(async (req, res) => {
  const g = await findGroup(req.params.id);
  const me = await membershipOf(g.id, req.user.id);
  const target = await membershipOf(g.id, req.params.userId);
  if (!target) throw new HttpError(404, 'A‘zo topilmadi');
  if (target.role === 'owner') throw new HttpError(400, 'Superadminni chiqarib bo‘lmaydi');
  need(isOwnerM(me) || (canRemoveM(me) && target.role === 'member'), 'Bu a‘zoni chiqarish huquqi yo‘q');
  await query('delete from group_members where group_id=$1 and user_id=$2', [g.id, req.params.userId]);
  await notify(req.params.userId, {
    type: 'group_removed',
    title: `«${g.name}» guruhidan chiqarildingiz`,
    link: '/app/groups',
  });
  res.json({ ok: true });
}));

// Qo'shilish: maxfiy guruhga faqat havola orqali, admin tasdig'i kerak bo'lsa so'rov yuboriladi
router.post('/groups/:id/join', ...guard, wrap(async (req, res) => {
  const g = await findGroup(req.params.id);
  const me = req.user;
  if (await membershipOf(g.id, me.id)) return res.json({ status: 'member' });
  if (g.visibility === 'private') throw new HttpError(403, 'Bu maxfiy guruh. Qo‘shilish uchun taklif havolasi kerak');

  if (g.is_private) {
    await query('insert into group_requests (group_id, user_id) values ($1,$2) on conflict do nothing', [g.id, me.id]);
    await notifyManagers(g.id, {
      type: 'group_request',
      title: `${me.full_name} «${g.name}» guruhiga qo‘shilmoqchi`,
      body: 'Tasdiqlash uchun guruhni oching',
      link: `/app/groups?g=${g.id}`,
    }, me.id);
    return res.status(201).json({ status: 'requested' });
  }

  await query(`insert into group_members (group_id, user_id, role) values ($1,$2,'member') on conflict do nothing`, [g.id, me.id]);
  await notifyManagers(g.id, {
    type: 'group_joined',
    title: `${me.full_name} «${g.name}» guruhiga qo‘shildi`,
    link: `/app/groups?g=${g.id}`,
  }, me.id);
  res.json({ status: 'member' });
}));

// Taklif havolasi kodi orqali to'g'ridan-to'g'ri qo'shilish (maxfiy guruhlar uchun ham)
router.post('/groups/join-code', ...guard, wrap(async (req, res) => {
  const { code } = z.object({ code: z.string().trim().min(4).max(64) }).parse(req.body);
  const { rows } = await query('select * from groups where invite_code=$1', [code]);
  const g = rows[0];
  if (!g) throw new HttpError(404, 'Havola noto‘g‘ri yoki eskirgan');
  if (!(await membershipOf(g.id, req.user.id))) {
    await query(`insert into group_members (group_id, user_id, role) values ($1,$2,'member') on conflict do nothing`, [g.id, req.user.id]);
    await notifyManagers(g.id, {
      type: 'group_joined',
      title: `${req.user.full_name} «${g.name}» guruhiga havola orqali qo‘shildi`,
      link: `/app/groups?g=${g.id}`,
    }, req.user.id);
  }
  res.json({ status: 'member', groupId: g.id });
}));

router.post('/groups/:id/leave', ...guard, wrap(async (req, res) => {
  const m = await membershipOf(req.params.id, req.user.id);
  if (!m) return res.json({ ok: true });
  if (m.role === 'owner') throw new HttpError(400, 'Superadmin guruhni tark etolmaydi');
  await query('delete from group_members where group_id=$1 and user_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

router.get('/groups/:id/requests', ...guard, wrap(async (req, res) => {
  const g = await findGroup(req.params.id);
  need(canApproveM(await membershipOf(g.id, req.user.id)), 'So‘rovlarni ko‘rish huquqi yo‘q');
  const { rows } = await query(
    `select u.id, u.username, u.full_name, u.faculty, u.avatar_url, r.created_at
     from group_requests r join users u on u.id = r.user_id
     where r.group_id=$1 order by r.created_at asc limit 200`,
    [g.id],
  );
  res.json({ requests: rows.map((r) => ({ id: r.id, username: r.username, fullName: r.full_name, faculty: r.faculty, avatarUrl: r.avatar_url || null, createdAt: r.created_at })) });
}));

router.post('/groups/:id/requests/:userId/accept', ...guard, wrap(async (req, res) => {
  const g = await findGroup(req.params.id);
  need(canApproveM(await membershipOf(g.id, req.user.id)), 'So‘rovlarni tasdiqlash huquqi yo‘q');
  const { rowCount } = await query('delete from group_requests where group_id=$1 and user_id=$2', [g.id, req.params.userId]);
  if (!rowCount) throw new HttpError(404, 'So‘rov topilmadi');
  await query(`insert into group_members (group_id, user_id, role) values ($1,$2,'member') on conflict do nothing`, [g.id, req.params.userId]);
  await notify(req.params.userId, {
    type: 'group_accepted',
    title: `«${g.name}» guruhiga qabul qilindingiz`,
    link: `/app/groups?g=${g.id}`,
  });
  res.json({ ok: true });
}));

router.delete('/groups/:id/requests/:userId', ...guard, wrap(async (req, res) => {
  const g = await findGroup(req.params.id);
  need(canApproveM(await membershipOf(g.id, req.user.id)), 'So‘rovlarni rad etish huquqi yo‘q');
  await query('delete from group_requests where group_id=$1 and user_id=$2', [g.id, req.params.userId]);
  res.json({ ok: true });
}));

router.get('/groups/:id/messages', ...guard, wrap(async (req, res) => {
  await assertMember(req.params.id, req.user.id);
  await query(
    `insert into chat_reads (user_id, kind, target_id, read_at) values ($1,'group',$2,now())
     on conflict (user_id, kind, target_id) do update set read_at = now()`,
    [req.user.id, req.params.id],
  );
  const { rows } = await query(
    `select m.id, m.body, m.created_at, m.media_url, m.media_type, m.file_name, m.file_size, u.id as user_id, u.username, u.full_name, u.avatar_url
     from group_messages m join users u on u.id = m.user_id
     where m.group_id=$1 order by m.created_at desc limit 100`,
    [req.params.id],
  );
  res.json({
    messages: rows.reverse().map((m) => ({
      id: m.id,
      body: m.body,
      createdAt: m.created_at,
      mediaUrl: m.media_url, mediaType: m.media_type, fileName: m.file_name, fileSize: m.file_size ? Number(m.file_size) : null,
      author: { id: m.user_id, username: m.username, fullName: m.full_name, avatarUrl: m.avatar_url || null },
    })),
  });
}));

router.post('/groups/:id/messages', ...guard, wrap(async (req, res) => {
  await assertMember(req.params.id, req.user.id);
  const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
  await query('insert into group_messages (group_id, user_id, body) values ($1,$2,$3)', [req.params.id, req.user.id, body]);
  res.status(201).json({ ok: true });
}));

/* ---------- Direct messages ---------- */
router.get('/messages/threads', ...guard, wrap(async (req, res) => {
  const { rows } = await query(
    `select u.id, u.username, u.full_name, u.avatar_url, t.body, t.created_at
     from (
       select distinct on (partner) partner, body, created_at from (
         select case when sender_id = $1 then recipient_id else sender_id end as partner, body, created_at
         from direct_messages where sender_id = $1 or recipient_id = $1
       ) m order by partner, created_at desc
     ) t
     join users u on u.id = t.partner
     order by t.created_at desc limit 100`,
    [req.user.id],
  );
  res.json({
    threads: rows.map((r) => ({
      user: { id: r.id, username: r.username, fullName: r.full_name, avatarUrl: r.avatar_url || null },
      lastBody: r.body,
      lastAt: r.created_at,
    })),
  });
}));

router.get('/messages/:userId', ...guard, wrap(async (req, res) => {
  await query(
    `insert into chat_reads (user_id, kind, target_id, read_at) values ($1,'dm',$2,now())
     on conflict (user_id, kind, target_id) do update set read_at = now()`,
    [req.user.id, req.params.userId],
  );
  const { rows } = await query(
    `select id, sender_id, body, created_at, media_url, media_type, file_name, file_size from direct_messages
     where (sender_id=$1 and recipient_id=$2) or (sender_id=$2 and recipient_id=$1)
     order by created_at desc limit 100`,
    [req.user.id, req.params.userId],
  );
  res.json({
    messages: rows.reverse().map((m) => ({
      id: m.id, body: m.body, createdAt: m.created_at, mine: m.sender_id === req.user.id,
      mediaUrl: m.media_url, mediaType: m.media_type, fileName: m.file_name, fileSize: m.file_size ? Number(m.file_size) : null,
    })),
  });
}));

router.post('/messages/:userId', ...guard, wrap(async (req, res) => {
  if (req.params.userId === req.user.id) throw new HttpError(400, 'O‘zingizga xabar yuborib bo‘lmaydi');
  const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
  await query('insert into direct_messages (sender_id, recipient_id, body) values ($1,$2,$3)', [req.user.id, req.params.userId, body]);
  res.status(201).json({ ok: true });
}));

export default router;
