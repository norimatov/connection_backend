import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { HttpError, wrap } from '../utils/http.js';
import { checkPassword, hashPassword } from '../utils/security.js';
import { publicUser } from '../utils/mapper.js';
import { requireUser } from '../middleware/auth.js';
import { normalizePhone } from './auth.js';

const router = Router();
const auth = [requireUser];

async function findUser(username) {
  const { rows } = await query('select * from users where username=$1', [username.toLowerCase()]);
  if (!rows[0]) throw new HttpError(404, 'Foydalanuvchi topilmadi');
  return rows[0];
}

async function relationshipOf(viewerId, targetId) {
  if (viewerId === targetId) return 'self';
  const { rows } = await query(
    `select requester_id, status from connections
     where (requester_id=$1 and addressee_id=$2) or (requester_id=$2 and addressee_id=$1)`,
    [viewerId, targetId],
  );
  const c = rows[0];
  if (!c) return 'none';
  if (c.status === 'accepted') return 'connected';
  return c.requester_id === viewerId ? 'pending_out' : 'pending_in';
}

/* ---------- Qidiruv (hamma faol talabalar) ---------- */
router.get('/users', ...auth, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const { rows } = await query(
    `select * from users
     where is_banned = false and id <> $1
       and ($2 = '' or username ilike '%' || $2 || '%' or full_name ilike '%' || $2 || '%')
     order by full_name limit 20`,
    [req.user.id, q],
  );
  res.json({ users: rows.map((u) => publicUser(u)) });
}));

/* ---------- Profil ---------- */
router.get('/users/:username', ...auth, wrap(async (req, res) => {
  const u = await findUser(req.params.username);
  const relationship = await relationshipOf(req.user.id, u.id);
  const connected = relationship === 'connected' || relationship === 'self';
  const { rows: [s] } = await query(
    `select
       (select count(*) from posts where user_id=$1)::int as posts,
       (select count(*) from services where user_id=$1)::int as services,
       (select count(*) from connections where status='accepted' and (requester_id=$1 or addressee_id=$1))::int as connections,
       (select count(*) from group_members where user_id=$1)::int as groups`,
    [u.id],
  );
  let stories = [];
  if (connected) {
    const r = await query(
      `select id, media_url, media_type, caption, created_at from stories
       where user_id=$1 and expires_at > now() order by created_at asc`,
      [u.id],
    );
    stories = r.rows.map((x) => ({ id: x.id, mediaUrl: x.media_url, mediaType: x.media_type, caption: x.caption, createdAt: x.created_at }));
  }
  const showPhone = relationship === 'self' || (connected && u.show_phone);
  res.json({
    user: {
      ...publicUser(u),
      stats: { posts: s.posts, services: s.services, connections: s.connections, groups: s.groups },
      relationship,
      stories,
      ...(showPhone ? { phone: u.phone } : {}),
    },
  });
}));

router.get('/users/:username/posts', ...auth, wrap(async (req, res) => {
  const u = await findUser(req.params.username);
  const { rows } = await query(
    `select p.id, p.kind, p.title, p.body, p.created_at,
            (select count(*) from post_likes l where l.post_id = p.id)::int as likes
     from posts p where p.user_id=$1 order by p.created_at desc limit 30`,
    [u.id],
  );
  res.json({
    posts: rows.map((p) => ({ id: p.id, kind: p.kind, title: p.title, body: p.body, createdAt: p.created_at, likes: p.likes })),
  });
}));

router.get('/users/:username/services', ...auth, wrap(async (req, res) => {
  const u = await findUser(req.params.username);
  const { rows } = await query('select * from services where user_id=$1 order by created_at desc limit 30', [u.id]);
  res.json({
    services: rows.map((s) => ({
      id: s.id, type: s.type, category: s.category, title: s.title, description: s.description,
      price: s.price, contact: s.contact, createdAt: s.created_at,
    })),
  });
}));

router.get('/users/:username/connections', ...auth, wrap(async (req, res) => {
  const u = await findUser(req.params.username);
  const { rows } = await query(
    `select p.id, p.username, p.full_name, p.faculty, p.university, p.avatar_url
     from connections c
     join users p on p.id = (case when c.requester_id = $1 then c.addressee_id else c.requester_id end)
     where c.status='accepted' and (c.requester_id=$1 or c.addressee_id=$1)
     order by p.full_name limit 300`,
    [u.id],
  );
  res.json({
    connections: rows.map((c) => ({ id: c.id, username: c.username, fullName: c.full_name, faculty: c.faculty, university: c.university, avatarUrl: c.avatar_url || null })),
  });
}));

/* ---------- Mening akkauntim ---------- */
router.patch('/me', ...auth, wrap(async (req, res) => {
  const link = z.string().trim().max(200)
    .refine((v) => v === '' || /^https?:\/\//i.test(v), 'Havola http(s):// bilan boshlanishi kerak')
    .optional();
  const d = z.object({
    fullName: z.string().trim().min(2).max(80).optional(),
    university: z.string().trim().max(120).optional(),
    faculty: z.string().trim().max(120).optional(),
    bio: z.string().trim().max(300).optional(),
    course: z.number().int().min(1).max(6).nullable().optional(),
    githubUrl: link,
    websiteUrl: link,
    showPhone: z.boolean().optional(),
  }).parse(req.body);
  const { rows } = await query(
    `update users set
       full_name = coalesce($2, full_name),
       university = coalesce($3, university),
       faculty = coalesce($4, faculty),
       bio = coalesce($5, bio),
       course = case when $6::boolean then $7::int else course end,
       github_url = case when $8::text is null then github_url else nullif($8::text, '') end,
       website_url = case when $9::text is null then website_url else nullif($9::text, '') end,
       show_phone = coalesce($10::boolean, show_phone)
     where id=$1 returning *`,
    [req.user.id, d.fullName ?? null, d.university ?? null, d.faculty ?? null, d.bio ?? null,
     d.course !== undefined, d.course ?? null, d.githubUrl ?? null, d.websiteUrl ?? null, d.showPhone ?? null],
  );
  res.json({ user: publicUser(rows[0], true) });
}));

// Email yoki telefon qo'shish/almashtirish (o'zgarsa, tasdiqlash qayta talab qilinadi)
router.patch('/me/contact', ...auth, wrap(async (req, res) => {
  const d = z.object({
    email: z.string().trim().toLowerCase().email('Email noto‘g‘ri').max(120).optional(),
    phone: z.string().trim().min(1).optional(),
  }).parse(req.body);
  if (!d.email && !d.phone) throw new HttpError(400, 'Email yoki telefon raqamini kiriting');
  const phone = d.phone ? normalizePhone(d.phone) : null;
  if (phone && !/^\+\d{9,15}$/.test(phone)) throw new HttpError(400, 'Telefon raqami noto‘g‘ri formatda');
  const dup = await query(
    `select 1 from users where id <> $1
       and ((email is not null and email = $2) or (phone is not null and phone = $3))`,
    [req.user.id, d.email ?? null, phone],
  );
  if (dup.rowCount) throw new HttpError(409, 'Bu email yoki telefon boshqa akkauntda band');
  const { rows } = await query(
    `update users set
       email = coalesce($2, email),
       email_verified = case when $2::text is null then email_verified else false end,
       phone = coalesce($3, phone),
       phone_verified = case when $3::text is null then phone_verified else false end
     where id=$1 returning *`,
    [req.user.id, d.email ?? null, phone],
  );
  res.json({ user: publicUser(rows[0], true) });
}));

router.post('/me/password', ...auth, wrap(async (req, res) => {
  const d = z.object({
    current: z.string().min(1),
    next: z.string().min(8, 'Yangi parol kamida 8 belgi').max(100),
  }).parse(req.body);
  if (!(await checkPassword(d.current, req.user.password_hash))) throw new HttpError(400, 'Joriy parol noto‘g‘ri');
  await query('update users set password_hash=$2 where id=$1', [req.user.id, await hashPassword(d.next)]);
  res.json({ ok: true });
}));

router.post('/me/heartbeat', ...auth, wrap(async (req, res) => {
  const seconds = Math.min(Math.max(Math.floor(Number(req.body?.seconds) || 0), 0), 60);
  if (seconds > 0) {
    await query('update users set total_seconds = total_seconds + $2, last_seen_at = now() where id=$1', [req.user.id, seconds]);
    await query(
      `insert into activity_daily (user_id, day, seconds) values ($1, current_date, $2)
       on conflict (user_id, day) do update set seconds = activity_daily.seconds + excluded.seconds`,
      [req.user.id, seconds],
    );
  } else {
    await query('update users set last_seen_at = now() where id=$1', [req.user.id]);
  }
  res.json({ ok: true });
}));

router.get('/search/people', ...auth, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const univ = String(req.query.university || '').trim().slice(0, 120);
  const fac = String(req.query.faculty || '').trim().slice(0, 120);
  const course = Number(req.query.course) || null;
  if (course !== null && (course < 1 || course > 6)) throw new HttpError(400, 'Kurs 1-6 oralig‘ida bo‘lishi kerak');
  const { rows } = await query(
    `select * from users u
     where u.is_banned = false and u.id <> $1
       and ($2 = '' or u.username ilike '%' || $2 || '%' or u.full_name ilike '%' || $2 || '%')
       and ($3 = '' or u.university ilike '%' || $3 || '%')
       and ($4 = '' or u.faculty ilike '%' || $4 || '%')
       and ($5::int is null or u.course = $5::int)
     order by u.full_name limit 30`,
    [req.user.id, q, univ, fac, course],
  );
  const { rows: conns } = await query(
    'select requester_id, addressee_id, status from connections where requester_id=$1 or addressee_id=$1',
    [req.user.id],
  );
  const rel = new Map(conns.map((c) => {
    const other = c.requester_id === req.user.id ? c.addressee_id : c.requester_id;
    const value = c.status === 'accepted' ? 'connected' : c.requester_id === req.user.id ? 'pending_out' : 'pending_in';
    return [other, value];
  }));
  res.json({ users: rows.map((u) => ({ ...publicUser(u), relationship: rel.get(u.id) || 'none' })) });
}));

export default router;
