BEGIN;
CREATE TABLE IF NOT EXISTS schema_version (version integer PRIMARY KEY);
INSERT INTO schema_version VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS app_state (
  id integer PRIMARY KEY CHECK (id=1), chat_id text, owner_id text,
  participants jsonb NOT NULL DEFAULT '[]', consent jsonb NOT NULL DEFAULT '[]',
  paused boolean NOT NULL DEFAULT false, mode text NOT NULL DEFAULT 'social',
  memory_revision integer NOT NULL DEFAULT 0, poll_offset bigint NOT NULL DEFAULT 0,
  since_bot integer NOT NULL DEFAULT 0, last_bot_at timestamptz,
  character text NOT NULL DEFAULT '', quiet_start integer NOT NULL DEFAULT 23,
  quiet_end integer NOT NULL DEFAULT 9, model text NOT NULL DEFAULT '',
  last_poll_at timestamptz, last_model_error text
);
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS summary_checked_at timestamptz;
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS last_social_at timestamptz;
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS open_group boolean NOT NULL DEFAULT false;
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS mention_only boolean NOT NULL DEFAULT false;
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS chat_title text NOT NULL DEFAULT '';
INSERT INTO app_state (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS receipts (update_id bigint PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS inbox (
  update_id bigint PRIMARY KEY, payload jsonb NOT NULL, revision integer NOT NULL,
  status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz,
  plan jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY, telegram_id bigint, user_id text NOT NULL,
  author text NOT NULL, role text NOT NULL, body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), edited_at timestamptz,
  UNIQUE (role, telegram_id)
);
CREATE INDEX IF NOT EXISTS messages_search ON messages USING gin(to_tsvector('simple',body));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS topic_id text NOT NULL DEFAULT '0';
CREATE TABLE IF NOT EXISTS memories (
  id bigserial PRIMARY KEY, content text NOT NULL, author_id text NOT NULL,
  source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rules (
  id bigserial PRIMARY KEY, title text NOT NULL, content text NOT NULL,
  author_id text NOT NULL, source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (title)
);
CREATE TABLE IF NOT EXISTS games (
  id bigserial PRIMARY KEY, kind text NOT NULL, state jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reminders (
  id bigserial PRIMARY KEY, title text NOT NULL, due_at timestamptz NOT NULL,
  author_id text NOT NULL, status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outbox (
  id bigserial PRIMARY KEY, dedup_key text NOT NULL UNIQUE, kind text NOT NULL,
  body jsonb NOT NULL, revision integer NOT NULL, service boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(), telegram_id bigint, error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS characters (id bigserial PRIMARY KEY, content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS daily_usage (day text PRIMARY KEY, requests integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS skills (
  id bigserial PRIMARY KEY, title text NOT NULL UNIQUE, instructions text NOT NULL,
  author_id text NOT NULL, source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS episodes (
  id bigserial PRIMARY KEY, body text NOT NULL, source_ids jsonb NOT NULL,
  last_source_id bigint NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS participant_preferences (
  user_id text PRIMARY KEY,
  length_mode text NOT NULL DEFAULT 'balanced' CHECK (length_mode IN ('short','balanced','detailed')),
  humor_mode text NOT NULL DEFAULT 'light' CHECK (humor_mode IN ('off','light')),
  source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_version VALUES (2) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS onboarding_chats (
  chat_id text PRIMARY KEY, inviter_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_version VALUES (3) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS topics (
  id text PRIMARY KEY, name text NOT NULL, closed boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS topic_id text NOT NULL DEFAULT '0';
ALTER TABLE rules ADD COLUMN IF NOT EXISTS topic_id text NOT NULL DEFAULT '0';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS topic_id text NOT NULL DEFAULT '0';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS topic_id text NOT NULL DEFAULT '0';
ALTER TABLE games ADD COLUMN IF NOT EXISTS topic_id text NOT NULL DEFAULT '0';
DROP INDEX IF EXISTS one_active_game;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_game_per_topic ON games(topic_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS messages_topic_recent ON messages(topic_id,id DESC);
CREATE TABLE IF NOT EXISTS members (user_id text PRIMARY KEY,name text NOT NULL,active boolean NOT NULL DEFAULT true,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS stickers (id bigserial PRIMARY KEY,file_id text NOT NULL,file_unique_id text NOT NULL UNIQUE,emoji text NOT NULL DEFAULT '',set_name text NOT NULL DEFAULT '',source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS choices (id text PRIMARY KEY,label text NOT NULL,topic_id text NOT NULL,revision integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS pending_intents (user_id text NOT NULL,topic_id text NOT NULL,request_text text NOT NULL,allowed jsonb NOT NULL,revision integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,topic_id));
INSERT INTO schema_version VALUES (5) ON CONFLICT DO NOTHING;
INSERT INTO schema_version VALUES (4) ON CONFLICT DO NOTHING;
COMMIT;
