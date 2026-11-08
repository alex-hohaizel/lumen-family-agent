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
ALTER TABLE participant_preferences ADD COLUMN IF NOT EXISTS field_sources jsonb NOT NULL DEFAULT '{}';
ALTER TABLE chat_preferences ADD COLUMN IF NOT EXISTS field_sources jsonb NOT NULL DEFAULT '{}';
UPDATE participant_preferences SET field_sources=jsonb_build_object('language',source_message_id,'preferred_name',source_message_id,'length_mode',source_message_id,'humor_mode',source_message_id,'formality',source_message_id,'emoji_mode',source_message_id),source_message_id=NULL WHERE source_message_id IS NOT NULL AND field_sources='{}';
UPDATE chat_preferences SET field_sources=jsonb_build_object('language',source_message_id,'length_mode',source_message_id,'humor_mode',source_message_id,'formality',source_message_id,'emoji_mode',source_message_id),source_message_id=NULL WHERE source_message_id IS NOT NULL AND field_sources='{}';
CREATE TABLE IF NOT EXISTS domain_commands(id uuid PRIMARY KEY,domain text NOT NULL,actor_id text NOT NULL,arguments_hash text NOT NULL,result jsonb NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,source_ids jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS stock_items(id uuid PRIMARY KEY,name text NOT NULL,unit text NOT NULL CHECK(unit IN ('g','ml','piece')),quantity bigint NOT NULL DEFAULT 0 CHECK(quantity>=0),known boolean NOT NULL DEFAULT false,need bigint NOT NULL DEFAULT 0 CHECK(need>=0),version integer NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX IF NOT EXISTS stock_names ON stock_items(lower(name));
CREATE TABLE IF NOT EXISTS stock_aliases(item_id uuid NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,alias text NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(item_id,alias));
CREATE TABLE IF NOT EXISTS stock_movements(id uuid PRIMARY KEY,sequence bigserial UNIQUE,item_id uuid NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,kind text NOT NULL CHECK(kind IN ('purchase','consume','adjust','recount','reverse')),quantity bigint NOT NULL,actor_id text NOT NULL,reverses uuid UNIQUE REFERENCES stock_movements(id) ON DELETE CASCADE,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS stock_movements_item ON stock_movements(item_id,sequence);
CREATE TABLE IF NOT EXISTS stock_reservations(id uuid PRIMARY KEY,item_id uuid NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,actor_id text NOT NULL,quantity bigint NOT NULL CHECK(quantity>=0),status text NOT NULL DEFAULT 'active',expires_at timestamptz NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS stock_reservations_active ON stock_reservations(item_id,status,expires_at);
CREATE TABLE IF NOT EXISTS stock_receipts(id uuid PRIMARY KEY,actor_id text NOT NULL,lines jsonb NOT NULL,status text NOT NULL DEFAULT 'draft',source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS media_assets(id uuid PRIMARY KEY,owner_id text NOT NULL,title text NOT NULL,mime text NOT NULL,path text NOT NULL,sha256 text NOT NULL,bytes bigint NOT NULL,version integer NOT NULL DEFAULT 1,audience text NOT NULL CHECK(audience IN ('group','private')),status text NOT NULL DEFAULT 'available',topic_id text NOT NULL,parent_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,audience_source_id bigint REFERENCES messages(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS resource_links(asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,asset_version integer NOT NULL,resource_kind text NOT NULL,resource_id text NOT NULL,resource_version integer NOT NULL,PRIMARY KEY(asset_id,resource_kind,resource_id));
CREATE TABLE IF NOT EXISTS archive_collections(id uuid PRIMARY KEY,owner_id text NOT NULL,title text NOT NULL,audience text NOT NULL,version integer NOT NULL DEFAULT 1,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS archive_items(id uuid PRIMARY KEY,collection_id uuid NOT NULL REFERENCES archive_collections(id) ON DELETE CASCADE,asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,asset_version integer NOT NULL,caption text NOT NULL DEFAULT '',claim text NOT NULL,claimed_date text,position integer NOT NULL,author_id text NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,caption_source_id bigint REFERENCES messages(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS studio_projects(id uuid PRIMARY KEY,owner_id text NOT NULL,title text NOT NULL,audience text NOT NULL,version integer NOT NULL DEFAULT 1,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS studio_scenes(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,asset_version integer NOT NULL,position integer NOT NULL,start_seconds numeric NOT NULL,duration numeric NOT NULL,caption text NOT NULL,framing text NOT NULL,author_id text NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS media_jobs(id uuid PRIMARY KEY,kind text NOT NULL,resource_id uuid NOT NULL,resource_version integer NOT NULL,manifest jsonb NOT NULL,manifest_hash text NOT NULL,status text NOT NULL DEFAULT 'queued',stage text NOT NULL DEFAULT 'queued',actor_id text NOT NULL,topic_id text NOT NULL,audience text NOT NULL,revision integer NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,output_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,error_code text,started_at timestamptz,finished_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS media_jobs_due ON media_jobs(status,created_at);
CREATE TABLE IF NOT EXISTS media_job_inputs(job_id uuid NOT NULL REFERENCES media_jobs(id) ON DELETE CASCADE,asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,asset_version integer NOT NULL,PRIMARY KEY(job_id,asset_id));
CREATE TABLE IF NOT EXISTS media_garbage(id uuid PRIMARY KEY,path text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS media_destinations(id uuid PRIMARY KEY,owner_id text NOT NULL,chat_id text NOT NULL,title text NOT NULL,status text NOT NULL DEFAULT 'active',verified_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS asset_destination_grants(asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,destination_id uuid NOT NULL REFERENCES media_destinations(id) ON DELETE CASCADE,asset_version integer NOT NULL,grantor_id text NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(asset_id,destination_id));
CREATE TABLE IF NOT EXISTS media_publications(id uuid PRIMARY KEY,asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,actor_id text NOT NULL,manifest jsonb NOT NULL,status text NOT NULL DEFAULT 'queued',receipts jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS resource_views(id uuid PRIMARY KEY,actor_id text NOT NULL,topic_id text NOT NULL,audience text NOT NULL,revision integer NOT NULL,query jsonb NOT NULL,refs jsonb NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day');
CREATE OR REPLACE FUNCTION lumen_collect_media_file() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO media_garbage(id,path) VALUES(OLD.id,OLD.path) ON CONFLICT(id) DO NOTHING;RETURN OLD;END $$;
DROP TRIGGER IF EXISTS media_file_erase ON media_assets;
CREATE TRIGGER media_file_erase BEFORE DELETE ON media_assets FOR EACH ROW EXECUTE FUNCTION lumen_collect_media_file();
CREATE TABLE IF NOT EXISTS learning_goals(id uuid PRIMARY KEY,actor_id text NOT NULL,title text NOT NULL,status text NOT NULL DEFAULT 'active',version integer NOT NULL DEFAULT 1,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS learning_exercises(id uuid NOT NULL,version integer NOT NULL,goal_id uuid NOT NULL REFERENCES learning_goals(id) ON DELETE CASCADE,spec jsonb NOT NULL,active boolean NOT NULL DEFAULT true,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(id,version));
CREATE TABLE IF NOT EXISTS learning_attempts(id uuid PRIMARY KEY,goal_id uuid NOT NULL REFERENCES learning_goals(id) ON DELETE CASCADE,actor_id text NOT NULL,exercise_id uuid NOT NULL,exercise_version integer NOT NULL,skill text NOT NULL,answer text NOT NULL DEFAULT '',score numeric,status text NOT NULL DEFAULT 'open',feedback text NOT NULL DEFAULT '',grading jsonb NOT NULL DEFAULT '{}',appeal text,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,answer_source_id bigint REFERENCES messages(id) ON DELETE CASCADE,grading_source_id bigint REFERENCES messages(id) ON DELETE SET NULL,review_source_id bigint REFERENCES messages(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(exercise_id,exercise_version) REFERENCES learning_exercises(id,version) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS learning_progress(goal_id uuid NOT NULL REFERENCES learning_goals(id) ON DELETE CASCADE,skill text NOT NULL,attempts integer NOT NULL,mastery numeric NOT NULL,next_at timestamptz NOT NULL,PRIMARY KEY(goal_id,skill));
CREATE TABLE IF NOT EXISTS calendar_setups(id uuid PRIMARY KEY,owner_id text NOT NULL,endpoint text NOT NULL,revision integer NOT NULL,status text NOT NULL DEFAULT 'pending',scope text NOT NULL DEFAULT 'freebusy',expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS calendar_connections(id uuid PRIMARY KEY,owner_id text NOT NULL,title text NOT NULL,endpoint text NOT NULL,credential_name text NOT NULL,scope text NOT NULL,status text NOT NULL,checked_at timestamptz,next_sync timestamptz NOT NULL DEFAULT now(),last_window jsonb,error_code text);
CREATE TABLE IF NOT EXISTS calendar_occurrences(connection_id uuid NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,uid text NOT NULL,recurrence_id text NOT NULL,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,busy boolean NOT NULL,etag text NOT NULL,PRIMARY KEY(connection_id,uid,recurrence_id,starts_at));
CREATE TABLE IF NOT EXISTS calendar_mirrors(id uuid PRIMARY KEY,connection_id uuid NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,uid text NOT NULL,href text NOT NULL,title text NOT NULL,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,etag text NOT NULL,status text NOT NULL,version integer NOT NULL DEFAULT 1,group_event_id uuid,group_chat_id text,next_check timestamptz NOT NULL DEFAULT now(),source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,UNIQUE(connection_id,uid));
CREATE TABLE IF NOT EXISTS calendar_operations(id uuid PRIMARY KEY,connection_id uuid NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,kind text NOT NULL,uid text NOT NULL,href text NOT NULL,desired jsonb NOT NULL,etag text,status text NOT NULL DEFAULT 'reserved',receipt jsonb,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS calendar_proposals(id uuid PRIMARY KEY,actor_id text NOT NULL,topic_id text NOT NULL,title text NOT NULL,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,minutes integer NOT NULL,timezone text NOT NULL,revision integer NOT NULL,version integer NOT NULL DEFAULT 1,selected jsonb,group_event_id uuid REFERENCES group_events(id) ON DELETE SET NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day');
CREATE TABLE IF NOT EXISTS calendar_shares(token text PRIMARY KEY,proposal_id uuid NOT NULL REFERENCES calendar_proposals(id) ON DELETE CASCADE,actor_id text NOT NULL,status text NOT NULL DEFAULT 'waiting',mode text NOT NULL DEFAULT 'calendar',intervals jsonb NOT NULL DEFAULT '[]',connection_options jsonb NOT NULL DEFAULT '[]',ui_version integer,ui_mode text,connection_id uuid,checked_at timestamptz,expires_at timestamptz NOT NULL DEFAULT now(),UNIQUE(proposal_id,actor_id));
ALTER TABLE daily_usage ADD COLUMN IF NOT EXISTS physical_requests bigint NOT NULL DEFAULT 0;
ALTER TABLE daily_usage ADD COLUMN IF NOT EXISTS input_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE daily_usage ADD COLUMN IF NOT EXISTS output_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE daily_usage ADD COLUMN IF NOT EXISTS failed_requests bigint NOT NULL DEFAULT 0;
ALTER TABLE daily_usage ADD COLUMN IF NOT EXISTS usage_missing bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS canonical_outcomes(source_kind text NOT NULL,source_key text NOT NULL,topic_id text NOT NULL,status text NOT NULL,finished_at timestamptz NOT NULL,version integer NOT NULL DEFAULT 1,PRIMARY KEY(source_kind,source_key));
ALTER TABLE canonical_outcomes ALTER COLUMN finished_at DROP NOT NULL;
ALTER TABLE canonical_outcomes ADD COLUMN IF NOT EXISTS time_precision text NOT NULL DEFAULT 'inferred' CHECK(time_precision IN ('exact','inferred'));
CREATE OR REPLACE FUNCTION lumen_outcome_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_status text; terminal boolean;
BEGIN
 IF TG_OP='DELETE' THEN DELETE FROM canonical_outcomes WHERE source_kind=TG_TABLE_NAME AND source_key=OLD.id::text; RETURN OLD; END IF;
 current_status:=CASE WHEN TG_TABLE_NAME='games' THEN to_jsonb(NEW)->>'status' ELSE to_jsonb(NEW)->>'phase' END;
 terminal:=current_status IN ('completed','cancelled');
 INSERT INTO canonical_outcomes(source_kind,source_key,topic_id,status,finished_at,time_precision) VALUES(TG_TABLE_NAME,NEW.id::text,NEW.topic_id,current_status,CASE WHEN terminal THEN now() ELSE NULL END,CASE WHEN terminal THEN 'exact' ELSE 'inferred' END)
 ON CONFLICT(source_kind,source_key) DO UPDATE SET topic_id=excluded.topic_id,status=excluded.status,
 finished_at=CASE WHEN canonical_outcomes.status NOT IN ('completed','cancelled') AND terminal THEN now() ELSE canonical_outcomes.finished_at END,
 time_precision=CASE WHEN canonical_outcomes.status NOT IN ('completed','cancelled') AND terminal THEN 'exact' ELSE canonical_outcomes.time_precision END,version=canonical_outcomes.version+1;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lumen_outcome_sync ON games;
CREATE TRIGGER lumen_outcome_sync AFTER INSERT OR UPDATE OR DELETE ON games FOR EACH ROW EXECUTE FUNCTION lumen_outcome_sync();
DROP TRIGGER IF EXISTS lumen_outcome_sync ON activity_sessions;
CREATE TRIGGER lumen_outcome_sync AFTER INSERT OR UPDATE OR DELETE ON activity_sessions FOR EACH ROW EXECUTE FUNCTION lumen_outcome_sync();
INSERT INTO canonical_outcomes(source_kind,source_key,topic_id,status,finished_at) SELECT 'games',id::text,topic_id,status,updated_at FROM games ON CONFLICT DO NOTHING;
INSERT INTO canonical_outcomes(source_kind,source_key,topic_id,status,finished_at) SELECT 'activity_sessions',id::text,topic_id,phase,created_at FROM activity_sessions ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS activity_passes(session_id uuid NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,round integer NOT NULL,user_id text NOT NULL,PRIMARY KEY(session_id,round,user_id));
CREATE TABLE IF NOT EXISTS recurring_series(id uuid PRIMARY KEY,actor_id text NOT NULL,topic_id text NOT NULL,rule jsonb NOT NULL,version integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'draft',revision integer NOT NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,confirmed_at timestamptz,last_materialized timestamptz,next_check timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS recurring_occurrences(series_id uuid NOT NULL REFERENCES recurring_series(id) ON DELETE CASCADE,occurrence_key text NOT NULL,due_at timestamptz NOT NULL,status text NOT NULL DEFAULT 'pending',version integer NOT NULL DEFAULT 1,schedule_id uuid REFERENCES scheduled_actions(id) ON DELETE SET NULL,PRIMARY KEY(series_id,occurrence_key));

ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS acceptance jsonb NOT NULL DEFAULT '[]';
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS criteria_version integer NOT NULL DEFAULT 1;
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS completion_evidence jsonb NOT NULL DEFAULT '{}';

ALTER TABLE web_monitors ADD COLUMN IF NOT EXISTS last_observation jsonb;
ALTER TABLE calendar_setups ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Europe/Kyiv';
ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Europe/Kyiv';
ALTER TABLE calendar_mirrors ADD COLUMN IF NOT EXISTS recurrence_id text NOT NULL DEFAULT '';
ALTER TABLE calendar_mirrors DROP CONSTRAINT IF EXISTS calendar_mirrors_connection_id_uid_key;
CREATE UNIQUE INDEX IF NOT EXISTS calendar_mirror_occurrence ON calendar_mirrors(connection_id,uid,recurrence_id);

ALTER TABLE calendar_shares ADD COLUMN IF NOT EXISTS event_ui_version integer;
CREATE TABLE IF NOT EXISTS game_segments(game_id bigint NOT NULL REFERENCES games(id) ON DELETE CASCADE,ordinal integer NOT NULL,body text NOT NULL,user_id text,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(game_id,ordinal));
CREATE TABLE IF NOT EXISTS activity_story_segments(session_id uuid NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,ordinal integer NOT NULL,body text NOT NULL,user_id text,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(session_id,ordinal));
INSERT INTO schema_version VALUES(14) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS image_designs(id uuid PRIMARY KEY,actor_id text NOT NULL,topic_id text NOT NULL,audience text NOT NULL,spec jsonb NOT NULL,version integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'draft',revision integer NOT NULL,output_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS media_derivations(input_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,output_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,input_version integer NOT NULL,PRIMARY KEY(input_id,output_id));

ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS completion_source_ids jsonb NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS statistics_preferences(user_id text PRIMARY KEY,ranking_opt_in boolean NOT NULL DEFAULT false,source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS outcome_changes(source_kind text NOT NULL,source_key text NOT NULL,version integer NOT NULL,previous_status text NOT NULL,status text NOT NULL,changed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(source_kind,source_key,version),FOREIGN KEY(source_kind,source_key) REFERENCES canonical_outcomes(source_kind,source_key) ON DELETE CASCADE);
CREATE OR REPLACE FUNCTION lumen_outcome_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status IS DISTINCT FROM NEW.status THEN INSERT INTO outcome_changes VALUES(NEW.source_kind,NEW.source_key,NEW.version,OLD.status,NEW.status,now()) ON CONFLICT DO NOTHING; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS lumen_outcome_history ON canonical_outcomes;
CREATE TRIGGER lumen_outcome_history AFTER UPDATE ON canonical_outcomes FOR EACH ROW EXECUTE FUNCTION lumen_outcome_history();

ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS name_source_id bigint REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS origin_source_id bigint REFERENCES messages(id) ON DELETE CASCADE;
CREATE TABLE IF NOT EXISTS stock_needs(id uuid PRIMARY KEY,item_id uuid NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,quantity bigint NOT NULL CHECK(quantity>=0),sequence bigint NOT NULL DEFAULT nextval('stock_movements_sequence_seq'),source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE);
ALTER TABLE archive_items ADD COLUMN IF NOT EXISTS field_sources jsonb NOT NULL DEFAULT '{}';

ALTER TABLE recurring_occurrences ADD COLUMN IF NOT EXISTS coalesced_count integer NOT NULL DEFAULT 1;
ALTER TABLE recurring_series ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'group' CHECK(audience IN ('group','private'));
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='stock_reservations' AND column_name='purpose') THEN
  ALTER TABLE stock_reservations ADD COLUMN purpose text NOT NULL DEFAULT 'stock' CHECK(purpose IN ('shopping','stock'));
  ALTER TABLE stock_reservations ALTER COLUMN purpose SET DEFAULT 'shopping';
 END IF;
END $$;
ALTER TABLE stock_reservations ADD COLUMN IF NOT EXISTS sequence bigint NOT NULL DEFAULT nextval('stock_movements_sequence_seq');
ALTER TABLE stock_reservations ADD COLUMN IF NOT EXISTS closed_sequence bigint;
ALTER TABLE stock_reservations ADD COLUMN IF NOT EXISTS closed_source_id bigint REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE stock_reservations ADD COLUMN IF NOT EXISTS initial_quantity bigint CHECK(initial_quantity>=0);
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS ingress_after timestamptz;
ALTER TABLE daily_usage ADD COLUMN IF NOT EXISTS prompt_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE daily_usage ADD COLUMN IF NOT EXISTS max_prompt_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE daily_usage ADD COLUMN IF NOT EXISTS image_inputs bigint NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS canonical_message_id bigint REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reservation_id uuid REFERENCES stock_reservations(id) ON DELETE SET NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='learning_exercises' AND column_name='question_version') THEN
  ALTER TABLE learning_exercises ADD COLUMN question_version integer NOT NULL DEFAULT 1;
  ALTER TABLE learning_exercises ADD COLUMN question_source_id bigint REFERENCES messages(id) ON DELETE CASCADE;
  UPDATE learning_exercises SET question_version=version,question_source_id=source_message_id;
 END IF;
END $$;
INSERT INTO schema_version VALUES(15) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS calendar_change_outbox(id uuid PRIMARY KEY,mirror_id uuid NOT NULL REFERENCES calendar_mirrors(id) ON DELETE CASCADE,version integer NOT NULL,group_chat_id text NOT NULL,group_event_id uuid NOT NULL,starts_at timestamptz,ends_at timestamptz,status text NOT NULL,revision integer NOT NULL,attempts integer NOT NULL DEFAULT 0,next_attempt timestamptz NOT NULL DEFAULT now(),delivered_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(mirror_id,version));
CREATE INDEX IF NOT EXISTS calendar_change_outbox_pending ON calendar_change_outbox(next_attempt) WHERE delivered_at IS NULL;
-- Addressed reads retain coverage metadata independently from reproducible payloads.
-- Originals live in attachments/agent_artifacts and are never part of this LRU.
CREATE TABLE IF NOT EXISTS media_inspections (
  id uuid PRIMARY KEY,
  cache_key text NOT NULL UNIQUE,
  namespace text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('attachment','artifact')),
  source_ref text NOT NULL,
  attachment_id bigint REFERENCES attachments(id) ON DELETE CASCADE,
  artifact_id uuid REFERENCES agent_artifacts(id) ON DELETE CASCADE,
  source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,
  request_source_id bigint REFERENCES messages(id) ON DELETE CASCADE,
  source_ids jsonb NOT NULL DEFAULT '[]',
  content_sha256 text NOT NULL,
  source_version text NOT NULL,
  revision integer NOT NULL,
  actor_id text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('group','private')),
  topic_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pdf_page','pdf_request','video_frame','video_answer','video_request')),
  address text NOT NULL,
  requested jsonb NOT NULL,
  decoder_version text NOT NULL,
  model_version text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  question_hash text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('requested','read','partial','unknown','failed')),
  coverage jsonb NOT NULL DEFAULT '{}',
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_kind='attachment' AND attachment_id IS NOT NULL AND artifact_id IS NULL)
      OR (source_kind='artifact' AND artifact_id IS NOT NULL AND attachment_id IS NULL))
);
CREATE INDEX IF NOT EXISTS media_inspections_source
  ON media_inspections(namespace,actor_id,audience,revision,source_kind,source_ref,content_sha256,source_version);
CREATE INDEX IF NOT EXISTS media_inspections_request_source ON media_inspections(request_source_id);
CREATE TABLE IF NOT EXISTS media_inspection_payloads (
  inspection_id uuid PRIMARY KEY REFERENCES media_inspections(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  payload_bytes integer NOT NULL CHECK (payload_bytes>0),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_inspection_payloads_expiry ON media_inspection_payloads(expires_at);

CREATE TABLE IF NOT EXISTS stock_item_sources(item_id uuid NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(item_id,source_message_id));
CREATE INDEX IF NOT EXISTS stock_item_sources_message ON stock_item_sources(source_message_id);
INSERT INTO stock_item_sources(item_id,source_message_id) SELECT id,name_source_id FROM stock_items WHERE name_source_id IS NOT NULL ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS stock_movement_sources(movement_id uuid NOT NULL REFERENCES stock_movements(id) ON DELETE CASCADE,source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(movement_id,source_message_id));
CREATE INDEX IF NOT EXISTS stock_movement_sources_message ON stock_movement_sources(source_message_id);
INSERT INTO stock_movement_sources(movement_id,source_message_id) SELECT id,source_message_id FROM stock_movements WHERE source_message_id IS NOT NULL ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS stock_need_sources(need_id uuid NOT NULL REFERENCES stock_needs(id) ON DELETE CASCADE,source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(need_id,source_message_id));
CREATE INDEX IF NOT EXISTS stock_need_sources_message ON stock_need_sources(source_message_id);
INSERT INTO stock_need_sources(need_id,source_message_id) SELECT id,source_message_id FROM stock_needs WHERE source_message_id IS NOT NULL ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS stock_reservation_sources(reservation_id uuid NOT NULL REFERENCES stock_reservations(id) ON DELETE CASCADE,source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(reservation_id,source_message_id));
CREATE INDEX IF NOT EXISTS stock_reservation_sources_message ON stock_reservation_sources(source_message_id);
INSERT INTO stock_reservation_sources(reservation_id,source_message_id) SELECT id,source_message_id FROM stock_reservations WHERE source_message_id IS NOT NULL ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS stock_release_sources(reservation_id uuid NOT NULL REFERENCES stock_reservations(id) ON DELETE CASCADE,source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(reservation_id,source_message_id));
CREATE INDEX IF NOT EXISTS stock_release_sources_message ON stock_release_sources(source_message_id);
INSERT INTO stock_release_sources(reservation_id,source_message_id) SELECT id,closed_source_id FROM stock_reservations WHERE closed_source_id IS NOT NULL ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS stock_receipt_sources(receipt_id uuid NOT NULL REFERENCES stock_receipts(id) ON DELETE CASCADE,source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(receipt_id,source_message_id));
CREATE INDEX IF NOT EXISTS stock_receipt_sources_message ON stock_receipt_sources(source_message_id);
INSERT INTO stock_receipt_sources(receipt_id,source_message_id) SELECT id,source_message_id FROM stock_receipts WHERE source_message_id IS NOT NULL ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS stock_alias_sources(item_id uuid NOT NULL,alias text NOT NULL,source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(item_id,alias,source_message_id),FOREIGN KEY(item_id,alias) REFERENCES stock_aliases(item_id,alias) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS stock_alias_sources_message ON stock_alias_sources(source_message_id);
INSERT INTO stock_alias_sources SELECT item_id,alias,source_message_id FROM stock_aliases WHERE source_message_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO schema_version VALUES(16) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS game_result_bases(source_kind text NOT NULL,source_key text NOT NULL,base_scores jsonb NOT NULL,source_ids jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(source_kind,source_key),FOREIGN KEY(source_kind,source_key) REFERENCES canonical_outcomes(source_kind,source_key) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS game_result_corrections(id uuid PRIMARY KEY,sequence bigserial UNIQUE,source_kind text NOT NULL,source_key text NOT NULL,canonical_version integer NOT NULL,actor_id text NOT NULL,reason text NOT NULL CHECK(length(trim(reason))>0),patch jsonb NOT NULL,before_scores jsonb NOT NULL,after_scores jsonb NOT NULL,source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,source_ids jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(source_kind,source_key) REFERENCES canonical_outcomes(source_kind,source_key) ON DELETE CASCADE,UNIQUE(source_kind,source_key,canonical_version));
CREATE INDEX IF NOT EXISTS game_result_corrections_sources ON game_result_corrections USING gin(source_ids);
INSERT INTO stock_movement_sources(movement_id,source_message_id) SELECT p.id,m.id FROM domain_commands d JOIN stock_movements p ON p.id::text=d.result->>'operation_id' CROSS JOIN LATERAL jsonb_array_elements_text(d.source_ids) v(id) JOIN messages m ON m.id::text=v.id WHERE d.domain='household' ON CONFLICT DO NOTHING;
INSERT INTO stock_need_sources(need_id,source_message_id) SELECT p.id,m.id FROM domain_commands d JOIN stock_needs p ON p.id::text=d.result->>'operation_id' CROSS JOIN LATERAL jsonb_array_elements_text(d.source_ids) v(id) JOIN messages m ON m.id::text=v.id WHERE d.domain='household' ON CONFLICT DO NOTHING;
INSERT INTO stock_reservation_sources(reservation_id,source_message_id) SELECT p.id,m.id FROM domain_commands d JOIN stock_reservations p ON p.id::text=d.result->>'operation_id' CROSS JOIN LATERAL jsonb_array_elements_text(d.source_ids) v(id) JOIN messages m ON m.id::text=v.id WHERE d.domain='household' ON CONFLICT DO NOTHING;
INSERT INTO stock_receipt_sources(receipt_id,source_message_id) SELECT p.id,m.id FROM domain_commands d JOIN stock_receipts p ON p.id::text=d.result->>'id' CROSS JOIN LATERAL jsonb_array_elements_text(d.source_ids) v(id) JOIN messages m ON m.id::text=v.id WHERE d.domain='household' ON CONFLICT DO NOTHING;
INSERT INTO stock_item_sources(item_id,source_message_id) SELECT p.id,m.id FROM domain_commands d JOIN stock_items p ON p.id::text=d.result->'item'->>'id' CROSS JOIN LATERAL jsonb_array_elements_text(d.source_ids) v(id) JOIN messages m ON m.id::text=v.id WHERE d.domain='household' AND NOT (d.result ? 'operation_id') ON CONFLICT DO NOTHING;
ALTER TABLE archive_collections ADD COLUMN IF NOT EXISTS topic_id text NOT NULL DEFAULT '0';
ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS topic_id text NOT NULL DEFAULT '0';
UPDATE archive_collections c SET topic_id=m.topic_id FROM messages m WHERE m.id=c.source_message_id AND c.topic_id='0' AND NOT EXISTS(SELECT 1 FROM schema_version WHERE version=17);
UPDATE studio_projects p SET topic_id=m.topic_id FROM messages m WHERE m.id=p.source_message_id AND p.topic_id='0' AND NOT EXISTS(SELECT 1 FROM schema_version WHERE version=17);
INSERT INTO schema_version VALUES(17) ON CONFLICT DO NOTHING;
ALTER TABLE tool_runs ADD COLUMN IF NOT EXISTS provenance_version integer NOT NULL DEFAULT 0;
ALTER TABLE tool_runs ADD COLUMN IF NOT EXISTS effectful boolean;
UPDATE tool_runs r SET effectful=true WHERE effectful IS NULL AND EXISTS(SELECT 1 FROM effect_operations e WHERE e.operation_key=r.dedup_key);
INSERT INTO schema_version VALUES(18) ON CONFLICT DO NOTHING;
ALTER TABLE learning_goals ADD COLUMN IF NOT EXISTS source_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE learning_exercises ADD COLUMN IF NOT EXISTS source_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE learning_attempts ADD COLUMN IF NOT EXISTS input_source_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE learning_attempts ADD COLUMN IF NOT EXISTS grading_source_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE learning_attempts ADD COLUMN IF NOT EXISTS review_source_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE learning_attempts ADD COLUMN IF NOT EXISTS appeal_source_ids jsonb NOT NULL DEFAULT '[]';
UPDATE learning_goals SET source_ids=jsonb_build_array(source_message_id) WHERE source_message_id IS NOT NULL AND source_ids='[]';
UPDATE learning_exercises SET source_ids=jsonb_build_array(source_message_id) WHERE source_message_id IS NOT NULL AND source_ids='[]';
INSERT INTO schema_version VALUES(19) ON CONFLICT DO NOTHING;

-- Companion improvements, schema 20.
-- Original ingress metadata follows its source lifetime. Legacy sources stay
-- unknown: plain body text cannot reconstruct native entities or transport.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS request_context jsonb DEFAULT NULL;
-- Round 1.13: provided soundtrack only; no synthesis/provider dependencies.
CREATE TABLE IF NOT EXISTS studio_soundtracks(
 project_id uuid PRIMARY KEY REFERENCES studio_projects(id) ON DELETE CASCADE,
 asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
 asset_version integer NOT NULL CHECK(asset_version>0),
 start_seconds numeric NOT NULL DEFAULT 0 CHECK(start_seconds>=0 AND start_seconds<=7200),
 loop boolean NOT NULL DEFAULT false,
 volume numeric NOT NULL DEFAULT 1 CHECK(volume>=0.05 AND volume<=1),
 fade_in numeric NOT NULL DEFAULT 0 CHECK(fade_in>=0 AND fade_in<=5),
 fade_out numeric NOT NULL DEFAULT 0 CHECK(fade_out>=0 AND fade_out<=5),
 author_id text NOT NULL,
 source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE
);
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS verification jsonb NOT NULL DEFAULT '{}';

ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES agent_tasks(id) ON DELETE CASCADE;
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS goal_version integer;

-- Additive 1.13 schema. Lists are an event ledger, not inventory or project tasks.
-- The current projection is computed from surviving events in simple-lists.ts.
CREATE TABLE IF NOT EXISTS simple_list_events (
  id uuid PRIMARY KEY,
  ordinal bigserial UNIQUE NOT NULL,
  item_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('add','complete','remove')),
  category text NOT NULL CHECK (category IN ('shopping','todo')),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 300),
  normalized_text text NOT NULL,
  topic_id text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('group','private')),
  scope_actor text NOT NULL,
  owner_id text NOT NULL,
  actor_id text NOT NULL,
  source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id,source_message_id,operation),
  CHECK ((audience='private' AND scope_actor<>'') OR (audience='group' AND scope_actor=''))
);
CREATE INDEX IF NOT EXISTS simple_list_events_scope ON simple_list_events(topic_id,audience,scope_actor,category,ordinal);
CREATE INDEX IF NOT EXISTS simple_list_events_item ON simple_list_events(item_id,ordinal DESC);
CREATE INDEX IF NOT EXISTS simple_list_events_source ON simple_list_events(source_message_id);

ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS action_id uuid REFERENCES commitments(id) ON DELETE CASCADE;
ALTER TABLE simple_list_events ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS media_jobs_task_goal ON media_jobs(task_id,goal_version);
-- Persist task audience at admission. NULL is only a legacy/unknown state,
-- resolved conservatively by resolveTaskAudience until migration completes.
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS audience text
  CHECK (audience IN ('group','private'));

-- Private evidence narrows scope first. A group-default task_status generated by
-- old code is deliberately not proof that the task was intended for the group.
UPDATE agent_tasks t SET audience='private'
WHERE t.audience IS NULL AND (
  EXISTS (SELECT 1 FROM app_state s WHERE s.id=1 AND s.chat_id ~ '^[0-9]+$')
  OR EXISTS (SELECT 1 FROM media_jobs j WHERE j.task_id=t.id AND j.audience='private')
  OR EXISTS (SELECT 1 FROM tool_approvals a WHERE a.task_id=t.id AND a.audience='private')
  OR EXISTS (SELECT 1 FROM outbox o WHERE o.body->>'taskId'=t.id::text AND o.audience='private')
  OR EXISTS (SELECT 1 FROM inbox i WHERE i.payload->>'sourceId'=t.source_message_id::text
    AND i.payload->'message'->'from'->>'id'=t.actor_id
    AND i.payload->'message'->'chat'->>'type'='private')
);

-- Only retained original ingress proves a legacy group request. Finished inbox
-- payloads can be erased, so unavailable evidence never defaults to group.
UPDATE agent_tasks t SET audience='group'
WHERE t.audience IS NULL AND EXISTS (
  SELECT 1 FROM inbox i CROSS JOIN app_state s
  WHERE s.id=1 AND i.payload->>'sourceId'=t.source_message_id::text
    AND i.payload->'message'->'from'->>'id'=t.actor_id
    AND i.payload->'message'->'chat'->>'type' IN ('group','supergroup')
    AND i.payload->'message'->'chat'->>'id'=s.chat_id
    AND COALESCE(i.payload->'message'->>'message_thread_id','0')=t.topic_id
);
UPDATE agent_tasks SET audience='private' WHERE audience IS NULL;

-- Do not release an already queued legacy title/progress/result into the group.
-- Uncertain/sending deliveries remain untouched and are never auto-replayed.
UPDATE outbox o SET audience='private',
  body=jsonb_set(o.body,'{scopeTopicId}',to_jsonb(t.topic_id),true)
FROM agent_tasks t
WHERE t.audience='private' AND o.body->>'taskId'=t.id::text
  AND o.kind IN ('task_status','text') AND o.status='pending';

INSERT INTO schema_version VALUES(20) ON CONFLICT DO NOTHING;

-- Explicit shared management is separate from a group delivery destination.
-- Historical rows keep their original owner; never infer a grant from a title.
ALTER TABLE recurring_series ADD COLUMN IF NOT EXISTS shared boolean NOT NULL DEFAULT false;
ALTER TABLE recurring_series ADD COLUMN IF NOT EXISTS manager_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS shared boolean NOT NULL DEFAULT false;
ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS manager_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'group' CHECK(audience IN ('group','private'));
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS shared boolean NOT NULL DEFAULT false;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS manager_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'group' CHECK(audience IN ('group','private'));
CREATE TABLE IF NOT EXISTS reminder_clarifications (
  actor_id text NOT NULL,
  topic_id text NOT NULL,
  revision integer NOT NULL,
  source_message_id bigint REFERENCES messages(id) ON DELETE CASCADE,
  candidates jsonb NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('series_scope','which_root','private_series_scope','private_roots')),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(actor_id,topic_id)
);
INSERT INTO schema_version VALUES(21) ON CONFLICT DO NOTHING;

-- Source-bound conversational interruption; no permanent personality setting.
ALTER TABLE topic_attention ADD COLUMN IF NOT EXISTS silenced_source_id bigint REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE topic_attention ADD COLUMN IF NOT EXISTS silenced_revision integer;
ALTER TABLE topic_attention ADD COLUMN IF NOT EXISTS silenced_body_sha256 text;

COMMIT;
