-- +goose Up
ALTER TABLE agents ADD COLUMN pulse_interval_seconds INTEGER NOT NULL DEFAULT 1800
  CHECK (pulse_interval_seconds BETWEEN 60 AND 604800 AND pulse_interval_seconds % 60 = 0);

ALTER TABLE chat_sessions
  ADD COLUMN pulse BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN next_check_at TIMESTAMPTZ,
  ADD COLUMN check_requested_at TIMESTAMPTZ,
  ADD COLUMN deleting BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN cleanup_completed_at TIMESTAMPTZ,
  ADD COLUMN generation BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT chat_sessions_pulse_ck CHECK (
    (pulse AND kind = 'chat' AND parent_session_id IS NULL)
    OR (NOT pulse AND next_check_at IS NULL)
  );

CREATE INDEX chat_sessions_due_idx ON chat_sessions(next_check_at)
WHERE pulse AND NOT deleting;

CREATE TYPE chat_input_origin AS ENUM ('user', 'pulse', 'workflow_result');
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
CREATE UNIQUE INDEX chat_inputs_pulse_idx
ON chat_inputs(workspace_id, agent_name, session_id)
WHERE origin = 'pulse' AND completed_at IS NULL;

-- +goose Down
DROP INDEX chat_inputs_pulse_idx;
DROP INDEX chat_inputs_source_idx;
ALTER TABLE chat_inputs
  DROP CONSTRAINT chat_inputs_completion_ck,
  DROP CONSTRAINT chat_inputs_background_ck,
  DROP COLUMN origin, DROP COLUMN source_id, DROP COLUMN part_id,
  DROP COLUMN generation, DROP COLUMN completed_at, DROP COLUMN outcome;
DROP TYPE chat_background_outcome;
DROP TYPE chat_input_origin;
DROP INDEX chat_sessions_due_idx;
ALTER TABLE chat_sessions
  DROP CONSTRAINT chat_sessions_pulse_ck,
  DROP COLUMN pulse,
  DROP COLUMN next_check_at, DROP COLUMN check_requested_at, DROP COLUMN cleanup_completed_at, DROP COLUMN deleting, DROP COLUMN generation;
ALTER TABLE agents DROP COLUMN pulse_interval_seconds;
