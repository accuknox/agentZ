-- +goose Up
ALTER TABLE chat_sessions
  ADD COLUMN archived_at TIMESTAMPTZ,
  ADD COLUMN snoozed_until TIMESTAMPTZ,
  ADD COLUMN resumed_at TIMESTAMPTZ;

CREATE INDEX chat_sessions_wake_idx ON chat_sessions(snoozed_until)
WHERE snoozed_until IS NOT NULL;

CREATE INDEX chat_sessions_active_idx ON chat_sessions(
  workspace_id, source_updated_at DESC NULLS LAST, agent_name, session_id
) WHERE archived_at IS NULL AND parent_session_id IS NULL;

CREATE INDEX chat_sessions_shelves_idx ON chat_sessions(workspace_id, agent_name)
WHERE parent_session_id IS NULL
  AND (archived_at IS NOT NULL OR snoozed_until IS NOT NULL);

CREATE INDEX chat_sessions_expiry_idx ON chat_sessions(
  workspace_id, agent_name, GREATEST(source_updated_at, resumed_at)
) INCLUDE (session_id)
WHERE archived_at IS NULL AND parent_session_id IS NULL
  AND snoozed_until IS NULL AND status = 'idle';

-- +goose Down
ALTER TABLE chat_sessions
  DROP COLUMN resumed_at,
  DROP COLUMN snoozed_until,
  DROP COLUMN archived_at;
