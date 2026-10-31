-- Action recovery 1.13 — additive integration proposal; root/runtime own shared src.
-- Media schema proposal is docs/qa-1-13/media-schema.sql (task_id, goal_version,
-- verification). Do not duplicate those ALTER TABLE statements here.
-- Existing tool_runs/task_id/goal_version and media_publications.receipts suffice
-- for causal task -> successful export run -> media job -> output -> delivery.
-- Optional queue lookup index for task lifecycle checks:
CREATE INDEX IF NOT EXISTS media_jobs_task_goal ON media_jobs(task_id,goal_version);

-- Required agent-tools execute/preflight instrumentation (no new table required):
-- Wrap lookup/available/requested/background/schema checks in an audit try/catch.
-- On ToolError insert one status='failed' tool_runs row with safe known code,
-- finished_at=now(), task_id/goal_version/actor_id/revision/source_message_id.
-- arguments must be '{}' or an explicitly allowlisted summary; never raw args,
-- credentials, token values, private connector content or argument JSON in errors.
-- Dedup should hash the exact original name/args internally, use a separate
-- preflight prefix so failures cannot collide with executed tool idempotency.
-- Record provenance from c.sourceId/c.sourceIds after live revision/action checks.
-- Return/rethrow only safe ToolError.code. Foreground outcome keeps the specific
-- human recovery; the failed attempt remains inspectable after inbox cleanup.
-- Unknown tool names should be length-bounded and not copied into user text.

-- Required delivery contract (media proposal + runtime integration):
-- media_asset outbox body {mediaJobId,publicationId,id,version,sha256,taskId,
-- goalVersion,threadId}; actor_id/audience/source lineage match the original job.
-- On sent update only the matching publication to status='delivered', receipts:
-- [{provider:'telegram',chat_id,message_ids:[positive ids],verified_at:ISO}].
-- status='uncertain' stays uncertain; no automatic resend. Text task receipt is
-- insufficient to complete a media task; AgentTasks remains verifying until
-- output verification and that exact output/version publication are delivered.
