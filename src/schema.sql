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
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS goal_version integer NOT NULL DEFAULT 1;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS criteria jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS progress_message_id bigint;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS progress_at timestamptz;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS verified_at timestamptz;
CREATE TABLE IF NOT EXISTS task_events(id bigserial PRIMARY KEY,task_id uuid NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,goal_version integer NOT NULL,kind text NOT NULL,detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS task_stages(task_id uuid NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,position integer NOT NULL,title text NOT NULL,status text NOT NULL DEFAULT 'pending',started_at timestamptz,finished_at timestamptz,PRIMARY KEY(task_id,position));
CREATE TABLE IF NOT EXISTS private_requests(id uuid PRIMARY KEY,token text NOT NULL UNIQUE,recipient_id text NOT NULL,requester_id text NOT NULL,topic_id text NOT NULL,question text NOT NULL,purpose text NOT NULL,sharing text NOT NULL DEFAULT 'task',status text NOT NULL DEFAULT 'offered',answer text,session_id uuid,revision integer NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS knowledge_facts(id uuid PRIMARY KEY,actor_id text NOT NULL,subject text NOT NULL,kind text NOT NULL,content text NOT NULL,audience text NOT NULL DEFAULT 'group',status text NOT NULL DEFAULT 'active',confidence numeric NOT NULL DEFAULT 1,version integer NOT NULL DEFAULT 1,valid_until timestamptz,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS projects(id uuid PRIMARY KEY,actor_id text NOT NULL,topic_id text NOT NULL,title text NOT NULL,goal text NOT NULL,criteria text NOT NULL,status text NOT NULL DEFAULT 'active',version integer NOT NULL DEFAULT 1,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS project_tasks(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,title text NOT NULL,assignee_id text,due_at timestamptz,depends_on jsonb NOT NULL DEFAULT '[]',status text NOT NULL DEFAULT 'open',accepted boolean NOT NULL DEFAULT false,result text NOT NULL DEFAULT '',updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS decisions(id uuid PRIMARY KEY,actor_id text NOT NULL,topic_id text NOT NULL,question text NOT NULL,options jsonb NOT NULL,participants jsonb NOT NULL,method text NOT NULL DEFAULT 'ranked',status text NOT NULL DEFAULT 'open',deadline timestamptz NOT NULL,version integer NOT NULL DEFAULT 1,result jsonb,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS decision_ballots(decision_id uuid NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,user_id text NOT NULL,ranking jsonb NOT NULL,excluded jsonb NOT NULL DEFAULT '[]',updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(decision_id,user_id));
CREATE TABLE IF NOT EXISTS activity_sessions(id uuid PRIMARY KEY,actor_id text NOT NULL,topic_id text NOT NULL,template text NOT NULL,title text NOT NULL,phase text NOT NULL DEFAULT 'lobby',round integer NOT NULL DEFAULT 0,max_rounds integer NOT NULL DEFAULT 3,version integer NOT NULL DEFAULT 1,settings jsonb NOT NULL DEFAULT '{}',public_state jsonb NOT NULL DEFAULT '{}',deadline timestamptz,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS active_session_topic ON activity_sessions(topic_id) WHERE phase NOT IN ('completed','cancelled');
CREATE TABLE IF NOT EXISTS activity_players(session_id uuid NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,user_id text NOT NULL,name text NOT NULL,role text NOT NULL,private_state jsonb NOT NULL DEFAULT '{}',score integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'joined',PRIMARY KEY(session_id,user_id));
CREATE TABLE IF NOT EXISTS activity_moves(session_id uuid NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,round integer NOT NULL,user_id text NOT NULL,content text NOT NULL,sharing text NOT NULL DEFAULT 'reveal',created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(session_id,round,user_id));
CREATE TABLE IF NOT EXISTS research_cache(cache_key text PRIMARY KEY,query text NOT NULL,data jsonb NOT NULL,checked_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS skill_versions(workflow_id uuid NOT NULL REFERENCES agent_workflows(id) ON DELETE CASCADE,version integer NOT NULL,steps jsonb NOT NULL,examples jsonb NOT NULL DEFAULT '[]',status text NOT NULL DEFAULT 'draft',test_results jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workflow_id,version));
CREATE TABLE IF NOT EXISTS proactivity_preferences(user_id text PRIMARY KEY,enabled boolean NOT NULL DEFAULT true,digest boolean NOT NULL DEFAULT false,snoozed_until timestamptz,muted_topics jsonb NOT NULL DEFAULT '[]',updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS signals(id uuid PRIMARY KEY,actor_id text NOT NULL,topic_id text NOT NULL,title text NOT NULL,body text NOT NULL,reason text NOT NULL,dedup_key text NOT NULL UNIQUE,due_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,status text NOT NULL DEFAULT 'pending',audience text NOT NULL DEFAULT 'group',source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS result_receipts(id uuid PRIMARY KEY,actor_id text NOT NULL,task_id uuid REFERENCES agent_tasks(id) ON DELETE CASCADE,kind text NOT NULL,reference text NOT NULL,proof jsonb NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS capability_health(name text NOT NULL,actor_id text NOT NULL DEFAULT '',status text NOT NULL,detail text NOT NULL DEFAULT '',checked_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(name,actor_id));
ALTER TABLE tool_connections ADD COLUMN IF NOT EXISTS trusted_read_tools jsonb NOT NULL DEFAULT '[]';
ALTER TABLE tool_connections ADD COLUMN IF NOT EXISTS checked_at timestamptz;
ALTER TABLE tool_connections ADD COLUMN IF NOT EXISTS health text NOT NULL DEFAULT 'unverified';
ALTER TABLE web_monitors ADD COLUMN IF NOT EXISTS json_path text;
ALTER TABLE agent_artifacts ADD COLUMN IF NOT EXISTS encoding text NOT NULL DEFAULT 'utf8';
ALTER TABLE private_requests ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS coordination_offers(id uuid PRIMARY KEY,actor_id text NOT NULL,event_id uuid REFERENCES group_events(id) ON DELETE SET NULL,details jsonb NOT NULL,expires_at timestamptz NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE signals ADD COLUMN IF NOT EXISTS notified_at timestamptz;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE tool_runs ADD COLUMN IF NOT EXISTS goal_version integer NOT NULL DEFAULT 1;
ALTER TABLE tool_connections ADD COLUMN IF NOT EXISTS auth_metadata jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS oauth_setups(id uuid PRIMARY KEY,actor_id text NOT NULL,name text NOT NULL,endpoint text NOT NULL,issuer text NOT NULL,client_id text NOT NULL,scopes jsonb NOT NULL,topic_id text NOT NULL,revision integer NOT NULL,status text NOT NULL DEFAULT 'offered',device_credential text,token_endpoint text,interval_seconds integer NOT NULL DEFAULT 5,next_poll timestamptz,expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE tool_connections ADD COLUMN IF NOT EXISTS confirmation_contract jsonb NOT NULL DEFAULT '{}';
ALTER TABLE result_receipts ADD COLUMN IF NOT EXISTS goal_version integer NOT NULL DEFAULT 1;
ALTER TABLE private_requests ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES agent_tasks(id) ON DELETE CASCADE;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS progress_hash text;
ALTER TABLE task_stages ADD COLUMN IF NOT EXISTS unit_type text NOT NULL DEFAULT 'unknown';
ALTER TABLE activity_players ADD COLUMN IF NOT EXISTS team text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS provenance_edges(derived_kind text NOT NULL,derived_key text NOT NULL,source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(derived_kind,derived_key,source_message_id));
CREATE INDEX IF NOT EXISTS provenance_sources ON provenance_edges(source_message_id);
CREATE TABLE IF NOT EXISTS private_results(id uuid PRIMARY KEY,actor_id text NOT NULL,credential_name text NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day');
ALTER TABLE tool_grants ADD COLUMN IF NOT EXISTS share_to_group boolean NOT NULL DEFAULT false;
ALTER TABLE tool_grants ADD COLUMN IF NOT EXISTS share_fields jsonb NOT NULL DEFAULT '[]';
ALTER TABLE connection_setups ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES agent_tasks(id) ON DELETE CASCADE;
ALTER TABLE connection_setups ADD COLUMN IF NOT EXISTS goal_version integer NOT NULL DEFAULT 1;
ALTER TABLE connection_setups ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
ALTER TABLE oauth_setups ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES agent_tasks(id) ON DELETE CASCADE;
ALTER TABLE oauth_setups ADD COLUMN IF NOT EXISTS goal_version integer NOT NULL DEFAULT 1;
ALTER TABLE tool_connections ADD COLUMN IF NOT EXISTS verification_task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL;
ALTER TABLE tool_connections ADD COLUMN IF NOT EXISTS verification_goal_version integer NOT NULL DEFAULT 1;
ALTER TABLE tool_approvals ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'group';
INSERT INTO schema_version VALUES (10) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS interactions(id uuid PRIMARY KEY,actor_id text NOT NULL,topic_id text NOT NULL,kind text NOT NULL,spec jsonb NOT NULL,participants jsonb NOT NULL,phase text NOT NULL DEFAULT 'collecting',version integer NOT NULL DEFAULT 1,revision integer NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,parent_id uuid REFERENCES interactions(id) ON DELETE CASCADE,launch jsonb,winning_option integer,result text,card_hash text,card_seq integer NOT NULL DEFAULT 0,card_message_id bigint,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day');
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS card_seq integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS interactions_topic_phase ON interactions(topic_id,phase,created_at);
CREATE TABLE IF NOT EXISTS interaction_responses(interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,version integer NOT NULL,user_id text NOT NULL,choices jsonb NOT NULL DEFAULT '[]',content text NOT NULL DEFAULT '',decision text NOT NULL DEFAULT 'answer',submitted boolean NOT NULL DEFAULT false,result text,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(interaction_id,version,user_id));
CREATE TABLE IF NOT EXISTS message_panels(id uuid PRIMARY KEY,actor_id text NOT NULL,audience text NOT NULL DEFAULT 'group',topic_id text NOT NULL,pages jsonb NOT NULL,revision integer NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day');
ALTER TABLE polls ADD COLUMN IF NOT EXISTS interaction_id uuid REFERENCES interactions(id) ON DELETE SET NULL;
ALTER TABLE polls ADD COLUMN IF NOT EXISTS interaction_version integer;
INSERT INTO schema_version VALUES(11) ON CONFLICT DO NOTHING;
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS personalization_recovered boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS chat_preferences(id integer PRIMARY KEY CHECK(id=1),language text NOT NULL DEFAULT '',length_mode text NOT NULL DEFAULT '',humor_mode text NOT NULL DEFAULT '',formality text NOT NULL DEFAULT '',emoji_mode text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 1,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE participant_preferences ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT '';
ALTER TABLE participant_preferences ADD COLUMN IF NOT EXISTS preferred_name text NOT NULL DEFAULT '';
ALTER TABLE participant_preferences ADD COLUMN IF NOT EXISTS inferred_name text NOT NULL DEFAULT '';
ALTER TABLE participant_preferences ADD COLUMN IF NOT EXISTS formality text NOT NULL DEFAULT '';
ALTER TABLE participant_preferences ADD COLUMN IF NOT EXISTS emoji_mode text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS alias_observations(user_id text NOT NULL,alias text NOT NULL,source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(user_id,alias,source_message_id));
CREATE TABLE IF NOT EXISTS scheduled_actions(id uuid PRIMARY KEY,dedup_key text NOT NULL UNIQUE,author_id text NOT NULL,topic_id text NOT NULL,title text NOT NULL,instruction text NOT NULL,mode text NOT NULL CHECK(mode IN ('reminder','task')),due_at timestamptz NOT NULL,timezone text NOT NULL,status text NOT NULL,action_hash text NOT NULL,revision integer NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL,confirmed_at timestamptz,task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS confirmation_message_id bigint;
CREATE INDEX IF NOT EXISTS scheduled_actions_due ON scheduled_actions(status,due_at);
INSERT INTO schema_version VALUES(12) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS conversation_goals(id uuid PRIMARY KEY,actor_id text NOT NULL,topic_id text NOT NULL,goal text NOT NULL,version integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'waiting',audience text NOT NULL DEFAULT 'personal',question text NOT NULL DEFAULT '',missing_slot text NOT NULL DEFAULT '',why text NOT NULL DEFAULT '',allowed jsonb NOT NULL DEFAULT '[]',question_message_id bigint,revision integer NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS conversation_goals_current ON conversation_goals(topic_id,actor_id,status);
CREATE TABLE IF NOT EXISTS behavior_contributions(id uuid PRIMARY KEY,topic_id text NOT NULL,actor_id text NOT NULL,move text NOT NULL,meaning_key text NOT NULL,summary text NOT NULL,revision integer NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,outbox_prefix text NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS style_episodes(id uuid PRIMARY KEY,actor_id text NOT NULL,topic_id text NOT NULL,fields jsonb NOT NULL,scope text NOT NULL,goal_id uuid REFERENCES conversation_goals(id) ON DELETE CASCADE,revision integer NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS commitments(id uuid PRIMARY KEY,engine_version text NOT NULL DEFAULT '1.11',actor_id text NOT NULL,topic_id text NOT NULL,kind text NOT NULL,spec jsonb NOT NULL,spec_hash text NOT NULL,spec_version integer NOT NULL DEFAULT 1,state_version integer NOT NULL DEFAULT 1,phase text NOT NULL DEFAULT 'waiting_acceptance',expected_result text NOT NULL,revision integer NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,result jsonb,error_code text,expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS consent_grants(action_id uuid NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,actor_id text NOT NULL,spec_hash text NOT NULL,decision text NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(action_id,actor_id));
CREATE TABLE IF NOT EXISTS action_work(id uuid PRIMARY KEY,action_id uuid NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,spec_hash text NOT NULL,revision integer NOT NULL,kind text NOT NULL DEFAULT 'activate',status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,inbox_id bigint,available_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,error_code text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(action_id,spec_hash,kind));
ALTER TABLE action_work ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}';
ALTER TABLE action_work ADD COLUMN IF NOT EXISTS plan jsonb;
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES commitments(id) ON DELETE CASCADE;
CREATE TABLE IF NOT EXISTS effect_operations(id uuid PRIMARY KEY,action_id uuid REFERENCES commitments(id) ON DELETE CASCADE,operation_key text NOT NULL UNIQUE,actor_id text NOT NULL,topic_id text NOT NULL,arguments_hash text NOT NULL,phase text NOT NULL DEFAULT 'reserved',attempt_id uuid,revision integer NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,result jsonb,error_code text,dispatch_started_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS action_id uuid REFERENCES commitments(id) ON DELETE CASCADE;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS engine_version text NOT NULL DEFAULT '1.10';
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS pending_participants jsonb NOT NULL DEFAULT '[]';
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS card_message_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE interaction_responses ADD COLUMN IF NOT EXISTS spec_hash text NOT NULL DEFAULT '';
ALTER TABLE message_panels ADD COLUMN IF NOT EXISTS output_language text;
ALTER TABLE message_panels ADD COLUMN IF NOT EXISTS action_id uuid REFERENCES commitments(id) ON DELETE CASCADE;
ALTER TABLE message_panels ADD COLUMN IF NOT EXISTS result_version integer NOT NULL DEFAULT 1;
ALTER TABLE message_panels ADD COLUMN IF NOT EXISTS provenance_version integer NOT NULL DEFAULT 1;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS operation_id uuid REFERENCES effect_operations(id) ON DELETE CASCADE;
ALTER TABLE participant_preferences DROP CONSTRAINT IF EXISTS participant_preferences_length_mode_check;
ALTER TABLE participant_preferences DROP CONSTRAINT IF EXISTS participant_preferences_humor_mode_check;
ALTER TABLE participant_preferences ALTER COLUMN length_mode SET DEFAULT '';
ALTER TABLE participant_preferences ALTER COLUMN humor_mode SET DEFAULT '';
UPDATE participant_preferences p SET length_mode='' WHERE length_mode='balanced' AND (preferred_name<>'' OR inferred_name<>'') AND EXISTS(SELECT 1 FROM messages m WHERE m.id=p.source_message_id AND m.body !~* '(відпов|отвеч|пиши|говор|reply|respond|тон|стиль|tone|style|середн|звичайн|normal)' AND (p.preferred_name='' OR m.body~* '(називай|зови|называй|моє ім|мое имя|my name|call me)')) AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=p.source_message_id AND m.body~* '(довжин|корот|стисл|деталь|доклад|розгорн|balanced|length)') AND NOT EXISTS(SELECT 1 FROM schema_version WHERE version=13);
UPDATE participant_preferences p SET humor_mode='' WHERE humor_mode='light' AND (preferred_name<>'' OR inferred_name<>'') AND EXISTS(SELECT 1 FROM messages m WHERE m.id=p.source_message_id AND m.body !~* '(відпов|отвеч|пиши|говор|reply|respond|тон|стиль|tone|style|середн|звичайн|normal)' AND (p.preferred_name='' OR m.body~* '(називай|зови|называй|моє ім|мое имя|my name|call me)')) AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=p.source_message_id AND m.body~* '(жарт|гумор|шут|ірон|humor|joke)') AND NOT EXISTS(SELECT 1 FROM schema_version WHERE version=13);
INSERT INTO schema_version VALUES(13) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS composition_runs(id uuid PRIMARY KEY,actor_id text NOT NULL,topic_id text NOT NULL,plan jsonb NOT NULL,participants jsonb NOT NULL,phase text NOT NULL DEFAULT 'running',step_states jsonb NOT NULL DEFAULT '{}',outputs jsonb NOT NULL DEFAULT '{}',revision integer NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,interaction_id uuid REFERENCES interactions(id) ON DELETE CASCADE,deadline timestamptz NOT NULL,lease_until timestamptz,error_code text,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE composition_runs ADD COLUMN IF NOT EXISTS resume_version integer NOT NULL DEFAULT 1;
ALTER TABLE polls ADD COLUMN IF NOT EXISTS composition_id uuid REFERENCES composition_runs(id) ON DELETE CASCADE;
ALTER TABLE polls ADD COLUMN IF NOT EXISTS composition_step text;
COMMIT;
