CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username        TEXT UNIQUE NOT NULL,
  full_name       TEXT NOT NULL,
  email           TEXT UNIQUE NOT NULL,
  phone           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  university      TEXT NOT NULL DEFAULT '',
  faculty         TEXT NOT NULL DEFAULT '',
  bio             TEXT NOT NULL DEFAULT '',
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  phone_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned       BOOLEAN NOT NULL DEFAULT FALSE,
  total_seconds   BIGINT NOT NULL DEFAULT 0,
  last_seen_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('email', 'phone', 'reset')),
  code_hash   TEXT NOT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS posts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('post', 'announcement', 'job', 'service')),
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts (created_at DESC);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id  UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS groups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id   UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages (group_id, created_at);

CREATE TABLE IF NOT EXISTS direct_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_direct_messages ON direct_messages (sender_id, recipient_id, created_at);

CREATE TABLE IF NOT EXISTS activity_daily (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      DATE NOT NULL,
  seconds  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS founder_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       TEXT NOT NULL,
  email           TEXT NOT NULL,
  phone           TEXT NOT NULL DEFAULT '',
  subject         TEXT NOT NULL,
  category        TEXT NOT NULL,
  message         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'IN_REVIEW', 'REPLIED', 'CLOSED')),
  internal_notes  TEXT NOT NULL DEFAULT '',
  archived        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Email va telefon endi ixtiyoriy (kamida bittasi bo'lishi kerak, app darajasida tekshiriladi)
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;

CREATE TABLE IF NOT EXISTS services (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('offer', 'request')),
  category     TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  price        TEXT NOT NULL DEFAULT '',
  contact      TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_services_created ON services (created_at DESC);

CREATE TABLE IF NOT EXISTS connections (
  requester_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (requester_id, addressee_id),
  CHECK (requester_id <> addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_connections_addressee ON connections (addressee_id, status);

-- Guruh admini tasdiqlaydigan (yopiq) guruhlar
ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS group_requests (
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  link        TEXT NOT NULL DEFAULT '',
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);

-- Guruh rollari: owner (superadmin), admin, member + admin huquqlari
ALTER TABLE groups ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE groups ADD COLUMN IF NOT EXISTS invite_code TEXT;
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS can_remove BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS can_approve BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS can_edit BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE groups SET invite_code = encode(gen_random_bytes(6), 'hex') WHERE invite_code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_invite ON groups (invite_code);
UPDATE group_members gm SET role = 'owner', can_remove = TRUE, can_approve = TRUE, can_edit = TRUE
  FROM groups g WHERE g.id = gm.group_id AND g.created_by = gm.user_id AND gm.role <> 'owner';

-- Telegram bot: telefon tasdiqlash kodlari shu chatga yuboriladi
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_username TEXT;
CREATE TABLE IF NOT EXISTS telegram_links (
  token       TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id     BIGINT,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tg_links_chat ON telegram_links (chat_id);

-- Profil rasmi, guruh chati uchun media, 24 soatlik hikoyalar
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS media_type TEXT;
CREATE TABLE IF NOT EXISTS stories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_url   TEXT NOT NULL,
  media_type  TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
  caption     TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_user ON stories (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories (expires_at);

-- Fayl almashish: shaxsiy va guruh chatlarida istalgan fayl, guruh sozlamasi
ALTER TABLE groups ADD COLUMN IF NOT EXISTS members_can_send_media BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS file_size BIGINT;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS media_type TEXT;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS file_size BIGINT;

-- Profil: kurs, ochiq havolalar, telefonni ko'rsatish sozlamasi
ALTER TABLE users ADD COLUMN IF NOT EXISTS course INT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_phone BOOLEAN NOT NULL DEFAULT FALSE;

-- O'qilgan chat nuqtalari (shaxsiy chat va guruhlar uchun o'qilmagan xabarlar hisobi)
CREATE TABLE IF NOT EXISTS chat_reads (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
  target_id  UUID NOT NULL,
  read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, target_id)
);
