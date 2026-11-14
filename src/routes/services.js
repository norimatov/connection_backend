import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { HttpError, wrap } from '../utils/http.js';
import { requireUser } from '../middleware/auth.js';

const router = Router();
router.use(requireUser);

const mapService = (s) => ({
  id: s.id,
  type: s.type,
  category: s.category,
  title: s.title,
  description: s.description,
  price: s.price,
  contact: s.contact,
  createdAt: s.created_at,
  owner: { id: s.user_id, username: s.username, fullName: s.full_name, faculty: s.faculty, university: s.university, avatarUrl: s.avatar_url || null },
});

router.get('/services', wrap(async (req, res) => {
  const type = z.enum(['all', 'offer', 'request']).catch('all').parse(req.query.type);
  const category = String(req.query.category || '').trim().slice(0, 40);
  const { rows } = await query(
    `select s.*, u.username, u.full_name, u.faculty, u.university, u.avatar_url
     from services s join users u on u.id = s.user_id
     where ($1::text = 'all' or s.type = $1::text)
       and ($2::text = '' or s.category ilike '%' || $2::text || '%')
     order by s.created_at desc limit 60`,
    [type, category],
  );
  res.json({ services: rows.map(mapService) });
}));

router.post('/services', wrap(async (req, res) => {
  const d = z.object({
    type: z.enum(['offer', 'request']),
    category: z.string().trim().min(2).max(40),
    title: z.string().trim().min(3, 'Sarlavha kamida 3 belgi').max(120),
    description: z.string().trim().max(1000).default(''),
    price: z.string().trim().max(60).default(''),
    contact: z.string().trim().max(120).default(''),
  }).parse(req.body);
  const { rows } = await query(
    `insert into services (user_id, type, category, title, description, price, contact)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [req.user.id, d.type, d.category, d.title, d.description, d.price, d.contact],
  );
  res.status(201).json({ id: rows[0].id });
}));

router.delete('/services/:id', wrap(async (req, res) => {
  const { rowCount } = await query('delete from services where id=$1 and user_id=$2', [req.params.id, req.user.id]);
  if (!rowCount) throw new HttpError(404, 'E‘lon topilmadi yoki ruxsat yo‘q');
  res.json({ ok: true });
}));

export default router;
