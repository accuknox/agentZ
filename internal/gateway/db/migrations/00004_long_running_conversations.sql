-- +goose Up
ALTER TABLE agents ADD COLUMN automatic_check_interval_seconds INTEGER NOT NULL DEFAULT 1800
  CHECK (automatic_check_interval_seconds BETWEEN 60 AND 604800 AND automatic_check_interval_seconds % 60 = 0);

ALTER TABLE chat_sessions
  ADD COLUMN long_running BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN owner_id TEXT REFERENCES users(id),
  ADD COLUMN private_root_session_id TEXT,
  ADD COLUMN proactive_paused BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN next_check_at TIMESTAMPTZ,
  ADD COLUMN deleting BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN cleanup_completed_at TIMESTAMPTZ,
  ADD COLUMN generation BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT chat_sessions_private_binding_ck CHECK (
    (owner_id IS NULL) = (private_root_session_id IS NULL)
  ),
  ADD CONSTRAINT chat_sessions_proactivity_ck CHECK (
    (long_running AND kind = 'chat' AND parent_session_id IS NULL
      AND owner_id IS NOT NULL AND private_root_session_id = session_id
      AND next_check_at IS NOT NULL)
    OR (NOT long_running AND next_check_at IS NULL AND NOT proactive_paused)
  );

CREATE INDEX chat_sessions_due_idx ON chat_sessions(next_check_at)
WHERE long_running AND NOT proactive_paused AND NOT deleting;
CREATE INDEX chat_sessions_private_root_idx
ON chat_sessions(workspace_id, agent_name, private_root_session_id)
WHERE private_root_session_id IS NOT NULL;

CREATE TYPE chat_input_origin AS ENUM ('user', 'proactive', 'workflow_result');
CREATE TYPE chat_background_outcome AS ENUM ('quiet', 'update', 'failed', 'canceled');
ALTER TABLE chat_inputs
  ADD COLUMN origin chat_input_origin NOT NULL DEFAULT 'user',
  ADD COLUMN source_id TEXT,
  ADD COLUMN part_id TEXT,
  ADD COLUMN generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN background JSONB,
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN outcome chat_background_outcome,
  ADD CONSTRAINT chat_inputs_background_ck CHECK (
    (origin = 'user' AND source_id IS NULL AND part_id IS NULL
      AND background IS NULL AND completed_at IS NULL AND outcome IS NULL)
    OR (origin <> 'user' AND source_id IS NOT NULL AND part_id IS NOT NULL)
  ),
  ADD CONSTRAINT chat_inputs_completion_ck CHECK (
    (completed_at IS NULL) = (outcome IS NULL)
  );
CREATE UNIQUE INDEX chat_inputs_source_idx
ON chat_inputs(workspace_id, agent_name, session_id, origin, source_id)
WHERE origin <> 'user';
CREATE UNIQUE INDEX chat_inputs_proactive_idx
ON chat_inputs(workspace_id, agent_name, session_id)
WHERE origin = 'proactive' AND completed_at IS NULL;

CREATE TABLE chat_creations (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  request JSONB NOT NULL,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'uncertain', 'created')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, agent_name, session_id)
);

CREATE TABLE workflow_reports (
  run_uid TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  run_name TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  generation BIGINT NOT NULL,
  requested_phase TEXT NOT NULL,
  status_message TEXT NOT NULL,
  result JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'ready', 'suppressed', 'conflict')),
  chat_input_id UUID UNIQUE REFERENCES chat_inputs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE workflow_reports;
DROP TABLE chat_creations;
DROP INDEX chat_inputs_proactive_idx;
DROP INDEX chat_inputs_source_idx;
ALTER TABLE chat_inputs
  DROP CONSTRAINT chat_inputs_completion_ck,
  DROP CONSTRAINT chat_inputs_background_ck,
  DROP COLUMN origin, DROP COLUMN source_id, DROP COLUMN part_id,
  DROP COLUMN generation, DROP COLUMN background, DROP COLUMN completed_at, DROP COLUMN outcome;
DROP TYPE chat_background_outcome;
DROP TYPE chat_input_origin;
DROP INDEX chat_sessions_private_root_idx;
DROP INDEX chat_sessions_due_idx;
ALTER TABLE chat_sessions
  DROP CONSTRAINT chat_sessions_proactivity_ck,
  DROP CONSTRAINT chat_sessions_private_binding_ck,
  DROP COLUMN long_running, DROP COLUMN owner_id, DROP COLUMN private_root_session_id,
  DROP COLUMN proactive_paused,
  DROP COLUMN next_check_at, DROP COLUMN cleanup_completed_at, DROP COLUMN deleting, DROP COLUMN generation;
ALTER TABLE agents DROP COLUMN automatic_check_interval_seconds;
