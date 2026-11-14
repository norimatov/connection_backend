import { query } from '../db.js';

// Bildirishnoma yaratish. Xato bo'lsa asosiy amal to'xtamaydi.
export async function notify(userId, { type, title, body = '', link = '' }) {
  if (!userId) return;
  try {
    await query(
      'insert into notifications (user_id, type, title, body, link) values ($1,$2,$3,$4,$5)',
      [userId, type, title, body, link],
    );
  } catch (e) {
    console.error('Bildirishnoma xatosi:', e.message);
  }
}
