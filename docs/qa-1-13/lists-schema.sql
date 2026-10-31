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
  revision integer NOT NULL DEFAULT 0,
  source_message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id,source_message_id,operation),
  CHECK ((audience='private' AND scope_actor<>'') OR (audience='group' AND scope_actor=''))
);
ALTER TABLE simple_list_events ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS simple_list_events_scope ON simple_list_events(topic_id,audience,scope_actor,category,ordinal);
CREATE INDEX IF NOT EXISTS simple_list_events_item ON simple_list_events(item_id,ordinal DESC);
CREATE INDEX IF NOT EXISTS simple_list_events_source ON simple_list_events(source_message_id);
