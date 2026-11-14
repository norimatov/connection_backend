import { config } from '../config.js';
import { query } from '../db.js';
import { telegramApi, sendTelegram, siteButton } from './telegram.js';
import { issueCode } from './verification.js';

const digits = (s) => String(s || '').replace(/\D/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WELCOME =
  'Assalomu alaykum! URDU CONNECT botiga xush kelibsiz.\n\n' +
  'Akkauntingizni Telegram bilan ulash uchun saytdagi "Telegram botga ulanish" tugmasini bosing.';

async function welcome(chatId) {
  await sendTelegram(chatId, WELCOME, { reply_markup: siteButton() });
}

async function latestLink(chatId) {
  const { rows } = await query(
    'select * from telegram_links where chat_id=$1 and expires_at > now() order by created_at desc limit 1',
    [chatId],
  );
  return rows[0] || null;
}

async function onStart(chatId, payload) {
  if (!payload) return welcome(chatId);
  const { rows } = await query('select * from telegram_links where token=$1 and expires_at > now()', [payload]);
  if (!rows[0]) {
    return sendTelegram(chatId, 'Havola eskirgan yoki noto‘g‘ri. Saytdan qayta urinib ko‘ring.', { reply_markup: siteButton() });
  }
  await query('update telegram_links set chat_id=$2 where token=$1', [payload, chatId]);
  await sendTelegram(chatId, 'Endi telefon raqamingizni yuboring. U akkauntingizdagi raqam bilan solishtiriladi.', {
    reply_markup: {
      keyboard: [[{ text: 'Telefon raqamimni yuborish', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

async function onContact(msg) {
  const chatId = msg.chat.id;
  const c = msg.contact;
  const removeKb = { reply_markup: { remove_keyboard: true } };

  const link = await latestLink(chatId);
  if (!link) return sendTelegram(chatId, 'Avval saytdan "Telegram botga ulanish" tugmasini bosing.', removeKb);
  if (c.user_id !== msg.from.id) {
    return sendTelegram(chatId, 'Iltimos, faqat o‘zingizning kontaktingizni yuboring.', removeKb);
  }

  const { rows } = await query('select * from users where id=$1', [link.user_id]);
  const user = rows[0];
  if (!user) return;

  if (!user.phone || digits(user.phone) !== digits(c.phone_number)) {
    await query('delete from telegram_links where token=$1', [link.token]);
    return sendTelegram(chatId, 'Telegram raqami akkauntingizdagi telefon raqamiga mos kelmadi.', removeKb);
  }

  await query('update users set telegram_chat_id=$2, telegram_username=$3 where id=$1', [user.id, chatId, msg.from.username || null]);
  await query('delete from telegram_links where user_id=$1', [user.id]);
  await sendTelegram(chatId, `Telegram ulandi! Saytga o‘ting: ${config.telegram.siteUrl}`, removeKb);

  // Telefon hali tasdiqlanmagan bo'lsa, kodni darhol Telegramga yuboramiz
  if (!user.phone_verified) {
    const fresh = (await query('select * from users where id=$1', [user.id])).rows[0];
    await issueCode(fresh, 'phone', { force: true }).catch((e) => console.error('Kod yuborish:', e.message));
  }
}

async function handle(msg) {
  if (!msg) return;
  if (msg.contact) return onContact(msg);
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  if (text.startsWith('/start')) return onStart(chatId, text.split(/\s+/)[1] || '');
  if (text === '/site') return sendTelegram(chatId, `Sayt: ${config.telegram.siteUrl}`, { reply_markup: siteButton() });
  if (text === '/help') {
    return sendTelegram(chatId, 'Buyruqlar:\n/start — boshlash\n/site — sayt manzili\n/help — yordam', { reply_markup: siteButton() });
  }
  return welcome(chatId);
}

export async function startTelegramBot() {
  if (!config.telegram.token) {
    console.log('Telegram bot: TELEGRAM_BOT_TOKEN yo‘q, bot o‘chirilgan');
    return;
  }
  const me = await telegramApi('getMe', {});
  if (!me.ok) {
    console.error('Telegram bot ulanmadi:', me.description);
    return;
  }
  console.log(`Telegram bot ishga tushdi: @${me.result.username}`);

  let offset = 0;
  (async function poll() {
    for (;;) {
      const r = await telegramApi('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
      if (!r.ok) {
        console.error('getUpdates:', r.description);
        await sleep(5000);
        continue;
      }
      for (const u of r.result) {
        offset = u.update_id + 1;
        handle(u.message).catch((e) => console.error('Bot xatosi:', e.message));
      }
    }
  })();
}
