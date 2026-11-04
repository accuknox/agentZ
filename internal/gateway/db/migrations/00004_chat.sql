-- +goose Up
ALTER TABLE chat_sessions
  ADD COLUMN archived_at TIMESTAMPTZ,
  ADD COLUMN snoozed_until TIMESTAMPTZ,
  ADD COLUMN resumed_at TIMESTAMPTZ,
  ADD COLUMN woke_at TIMESTAMPTZ,
  ADD COLUMN deleting BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN cleanup_completed_at TIMESTAMPTZ,
  ADD COLUMN generation BIGINT NOT NULL DEFAULT 0;

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

CREATE TYPE chat_input_origin AS ENUM ('user', 'workflow_result');
CREATE TYPE chat_background_outcome AS ENUM ('quiet', 'update', 'failed', 'canceled');
ALTER TABLE chat_inputs
  ADD COLUMN origin chat_input_origin NOT NULL DEFAULT 'user',
  ADD COLUMN source_id TEXT,
  ADD COLUMN part_id TEXT,
  ADD COLUMN generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN outcome chat_background_outcome,
  ADD CONSTRAINT chat_inputs_background_ck CHECK (
    (origin = 'user' AND source_id IS NULL AND part_id IS NULL
      AND completed_at IS NULL AND outcome IS NULL)
    OR (origin <> 'user' AND source_id IS NOT NULL AND part_id IS NOT NULL)
  ),
  ADD CONSTRAINT chat_inputs_completion_ck CHECK (
    (completed_at IS NULL) = (outcome IS NULL)
  );
CREATE UNIQUE INDEX chat_inputs_source_idx
ON chat_inputs(workspace_id, agent_name, session_id, origin, source_id)
WHERE origin <> 'user';

-- +goose Down
DROP INDEX chat_inputs_source_idx;
ALTER TABLE chat_inputs
  DROP CONSTRAINT chat_inputs_completion_ck,
  DROP CONSTRAINT chat_inputs_background_ck,
  DROP COLUMN origin, DROP COLUMN source_id, DROP COLUMN part_id,
  DROP COLUMN generation, DROP COLUMN completed_at, DROP COLUMN outcome;
DROP TYPE chat_background_outcome;
DROP TYPE chat_input_origin;
ALTER TABLE chat_sessions
  DROP COLUMN cleanup_completed_at,
  DROP COLUMN deleting,
  DROP COLUMN generation,
  DROP COLUMN woke_at,
  DROP COLUMN resumed_at,
  DROP COLUMN snoozed_until,
  DROP COLUMN archived_at;
