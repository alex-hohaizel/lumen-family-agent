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
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS proactive_mode text NOT NULL DEFAULT 'helpful';
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS proactive_gap_minutes integer NOT NULL DEFAULT 45;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE games ADD COLUMN IF NOT EXISTS source_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'group';
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS actor_id text;
ALTER TABLE choices ADD COLUMN IF NOT EXISTS menu_id text NOT NULL DEFAULT '';
ALTER TABLE choices ADD COLUMN IF NOT EXISTS question text NOT NULL DEFAULT '';
ALTER TABLE choices ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'group';
ALTER TABLE choices ADD COLUMN IF NOT EXISTS target_user_id text;
ALTER TABLE choices ADD COLUMN IF NOT EXISTS source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE choices ADD COLUMN IF NOT EXISTS message_id bigint;
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS keywords text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS choice_votes (menu_id text NOT NULL,user_id text NOT NULL,name text NOT NULL,label text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(menu_id,user_id));
CREATE TABLE IF NOT EXISTS dialogues (topic_id text NOT NULL,user_id text NOT NULL,question text NOT NULL,kind text NOT NULL DEFAULT 'question',audience text NOT NULL DEFAULT 'personal',allowed jsonb NOT NULL DEFAULT '[]',source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,revision integer NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(topic_id,user_id));
CREATE TABLE IF NOT EXISTS attachments (id bigserial PRIMARY KEY,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,topic_id text NOT NULL DEFAULT '0',kind text NOT NULL,file_id text NOT NULL,file_unique_id text NOT NULL DEFAULT '',mime text NOT NULL DEFAULT '',metadata jsonb NOT NULL DEFAULT '{}',description text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'pending',revision integer NOT NULL,attempts integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(source_message_id,file_id));
CREATE INDEX IF NOT EXISTS attachments_recent ON attachments(topic_id,id DESC);
CREATE TABLE IF NOT EXISTS avatars (user_id text PRIMARY KEY,file_id text NOT NULL DEFAULT '',file_unique_id text NOT NULL DEFAULT '',description text NOT NULL DEFAULT '',updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS polls (poll_id text PRIMARY KEY,message_id bigint NOT NULL,topic_id text NOT NULL DEFAULT '0',question text NOT NULL,options jsonb NOT NULL,correct integer,revision integer NOT NULL,closed boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS poll_votes (poll_id text NOT NULL REFERENCES polls(poll_id) ON DELETE CASCADE,user_id text NOT NULL,name text NOT NULL,option_ids jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(poll_id,user_id));
CREATE TABLE IF NOT EXISTS image_jobs (id bigserial PRIMARY KEY,dedup_key text NOT NULL UNIQUE,prompt text NOT NULL,author_id text NOT NULL,author_name text NOT NULL,topic_id text NOT NULL DEFAULT '0',source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,reference_ids jsonb NOT NULL DEFAULT '[]',revision integer NOT NULL,status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,result_file_id text,result_description text NOT NULL DEFAULT '',cancelled boolean NOT NULL DEFAULT false,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS release_notices (version text PRIMARY KEY,status text NOT NULL DEFAULT 'pending',telegram_id bigint,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE image_jobs ADD COLUMN IF NOT EXISTS generation_version integer NOT NULL DEFAULT 1;
ALTER TABLE polls ADD COLUMN IF NOT EXISTS source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE daily_usage ADD COLUMN IF NOT EXISTS images integer NOT NULL DEFAULT 0;
INSERT INTO schema_version VALUES (6) ON CONFLICT DO NOTHING;
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS conversation_style text NOT NULL DEFAULT 'adaptive';
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS conversation_window_minutes integer NOT NULL DEFAULT 10;
INSERT INTO schema_version VALUES (7) ON CONFLICT DO NOTHING;
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS ambient_gap_seconds integer NOT NULL DEFAULT 120;
CREATE TABLE IF NOT EXISTS topic_attention (topic_id text PRIMARY KEY,checked_at timestamptz,checked_source_id bigint REFERENCES messages(id) ON DELETE SET NULL,spoke_at timestamptz,spoke_source_id bigint REFERENCES messages(id) ON DELETE SET NULL,last_reply text NOT NULL DEFAULT '');
UPDATE app_state SET ambient_gap_seconds=GREATEST(60,proactive_gap_minutes*60) WHERE proactive_gap_minutes<>45 AND NOT EXISTS(SELECT 1 FROM schema_version WHERE version=8);
INSERT INTO schema_version VALUES (8) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS agent_tasks (
 id uuid PRIMARY KEY,dedup_key text NOT NULL UNIQUE,actor_id text NOT NULL,topic_id text NOT NULL DEFAULT '0',
 title text NOT NULL,goal text NOT NULL,status text NOT NULL DEFAULT 'pending',revision integer NOT NULL,
 source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,step integer NOT NULL DEFAULT 0,max_steps integer NOT NULL DEFAULT 16,
 result text NOT NULL DEFAULT '',error_code text,available_at timestamptz NOT NULL DEFAULT now(),deadline timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_tasks_pending ON agent_tasks(status,available_at);
CREATE TABLE IF NOT EXISTS tool_runs (
 id bigserial PRIMARY KEY,dedup_key text NOT NULL UNIQUE,task_id uuid REFERENCES agent_tasks(id) ON DELETE CASCADE,
 actor_id text NOT NULL,tool text NOT NULL,arguments jsonb NOT NULL,status text NOT NULL DEFAULT 'running',
 result jsonb,error_code text,revision integer NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS tool_approvals (
 id uuid PRIMARY KEY,actor_id text NOT NULL,task_id uuid REFERENCES agent_tasks(id) ON DELETE CASCADE,
 tool text NOT NULL,arguments jsonb NOT NULL,argument_hash text NOT NULL,summary text NOT NULL,
 status text NOT NULL DEFAULT 'pending',revision integer NOT NULL,topic_id text NOT NULL,
 source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tool_credentials (owner_id text NOT NULL,name text NOT NULL,ciphertext text NOT NULL,iv text NOT NULL,tag text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,name));
CREATE TABLE IF NOT EXISTS tool_connections (id text NOT NULL,owner_id text NOT NULL,endpoint text NOT NULL,credential_name text,enabled boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,id));
CREATE TABLE IF NOT EXISTS tool_grants (
 id uuid PRIMARY KEY,actor_id text NOT NULL,connection_id text NOT NULL,tool text NOT NULL,
 expires_at timestamptz NOT NULL,daily_limit integer NOT NULL CHECK(daily_limit BETWEEN 1 AND 100),
 used_day date NOT NULL DEFAULT CURRENT_DATE,used_calls integer NOT NULL DEFAULT 0,revision integer NOT NULL,
 source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,
 FOREIGN KEY(actor_id,connection_id) REFERENCES tool_connections(owner_id,id) ON DELETE CASCADE,
 UNIQUE(actor_id,connection_id,tool)
);
CREATE TABLE IF NOT EXISTS agent_workflows (id uuid PRIMARY KEY,title text NOT NULL,actor_id text NOT NULL,steps jsonb NOT NULL,status text NOT NULL DEFAULT 'draft',version integer NOT NULL DEFAULT 1,verified_runs integer NOT NULL DEFAULT 0,last_error text,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS web_monitors (
 id uuid PRIMARY KEY,actor_id text NOT NULL,topic_id text NOT NULL,url text NOT NULL,label text NOT NULL,
 condition text NOT NULL DEFAULT 'change',needle text NOT NULL DEFAULT '',threshold numeric,
 interval_minutes integer NOT NULL DEFAULT 60,next_check_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 last_hash text,last_excerpt text NOT NULL DEFAULT '',last_notified_at timestamptz,status text NOT NULL DEFAULT 'active',
 revision integer NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,error_code text,failures integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_artifacts (id uuid PRIMARY KEY,actor_id text NOT NULL,topic_id text NOT NULL,name text NOT NULL,mime text NOT NULL,content text NOT NULL,revision integer NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS group_events (id uuid PRIMARY KEY,actor_id text NOT NULL,title text NOT NULL,details jsonb NOT NULL,status text NOT NULL DEFAULT 'planning',version integer NOT NULL DEFAULT 1,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,topic_id text NOT NULL DEFAULT '0',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS agent_feedback (id bigserial PRIMARY KEY,actor_id text NOT NULL,content text NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS memory_terms (term text PRIMARY KEY,alternatives jsonb NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS connection_setups (id uuid PRIMARY KEY,actor_id text NOT NULL,name text NOT NULL,endpoint text NOT NULL,status text NOT NULL DEFAULT 'pending',expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO schema_version VALUES (9) ON CONFLICT DO NOTHING;
COMMIT;
