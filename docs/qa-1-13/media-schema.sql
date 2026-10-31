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
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS action_id uuid REFERENCES commitments(id) ON DELETE CASCADE;
