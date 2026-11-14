import nodemailer from 'nodemailer';
import { config } from '../config.js';

const transport = config.smtp.host
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  : null;

export async function sendEmail(to, subject, text) {
  if (!transport) {
    console.log(`[EMAIL -> ${to}] ${subject}\n${text}`);
    return;
  }
  await transport.sendMail({ from: config.smtp.from, to, subject, text });
}

export async function sendSms(to, text) {
  if (!config.smsWebhookUrl) {
    console.log(`[SMS -> ${to}] ${text}`);
    return;
  }
  const res = await fetch(config.smsWebhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to, text }),
  });
  if (!res.ok) throw new Error(`SMS provider ${res.status}`);
}

// Telefon kodi: avval Telegram (agar ulangan bo'lsa), bo'lmasa SMS
export async function sendPhoneCode(user, text) {
  const full = `${text}\n\nSayt: ${config.telegram.siteUrl}`;
  if (user.telegram_chat_id && config.telegram.token) {
    const { siteButton, sendTelegram } = await import('./telegram.js');
    const ok = await sendTelegram(user.telegram_chat_id, full, { reply_markup: siteButton() });
    if (ok) return 'telegram';
  }
  await sendSms(user.phone, full);
  return 'sms';
}
