import { config } from '../config.js';

export function telegramApi(method, body) {
  if (!config.telegram.token) return Promise.resolve({ ok: false, description: 'Bot sozlanmagan' });
  return fetch(`https://api.telegram.org/bot${config.telegram.token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .catch((e) => ({ ok: false, description: e.message }));
}

export const siteButton = () => ({
  inline_keyboard: [[{ text: 'Saytga o‘tish', url: config.telegram.siteUrl }]],
});

export async function sendTelegram(chatId, text, extra = {}) {
  const r = await telegramApi('sendMessage', { chat_id: chatId, text, ...extra });
  if (!r.ok) console.error('Telegram xabar xatosi:', r.description);
  return !!r.ok;
}
