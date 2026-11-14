# Telegram bot sozlash

1. Telegramda **@BotFather** ni oching, `/newbot` yuboring.
2. Bot nomi va username (oxiri `bot` bilan, masalan `urdu_connect_bot`) ni kiriting.
3. BotFather bergan **token** ni nusxalang.
4. Ixtiyoriy: `/setdescription`, `/setabouttext`, `/setuserpic` bilan bot ko'rinishini sozlang.
5. Ixtiyoriy: `/setcommands` ga quyidagilarni yuboring:
   ```
   start - boshlash
   site - sayt manzili
   help - yordam
   ```
6. `backend/.env` ga qo'shing:
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_BOT_USERNAME=urdu_connect_bot
   SITE_URL=https://sizning-saytingiz.uz
   ```
7. Backendni qayta ishga tushiring. Terminalda `Telegram bot ishga tushdi: @...` chiqishi kerak.

Foydalanuvchi oqimi: saytda telefon qo'shing → "Telegram botga ulanish" → botda "Telefon raqamimni yuborish" → kod Telegramga keladi.
