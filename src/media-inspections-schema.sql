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
