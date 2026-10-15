-- +goose Up
CREATE TYPE chat_execution_state AS ENUM ('admitting', 'running', 'recovering', 'blocked', 'completed', 'cancelled', 'failed');
CREATE TYPE chat_attempt_state AS ENUM ('pending', 'submitting', 'interrupted', 'completed', 'cancelled', 'failed');
CREATE TYPE chat_protocol AS ENUM ('v1', 'v2');

CREATE TABLE chat_executions (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_uid TEXT NOT NULL,
  namespace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  directory TEXT NOT NULL,
  protocol chat_protocol NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  user_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  workflow_run_uid TEXT NOT NULL DEFAULT '',
  workflow_name TEXT NOT NULL DEFAULT '',
  workflow_run_name TEXT NOT NULL DEFAULT '',
  definition JSONB,
  deadline TIMESTAMPTZ,
  state chat_execution_state NOT NULL DEFAULT 'admitting',
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  continuations INTEGER NOT NULL DEFAULT 0 CHECK (continuations BETWEEN 0 AND 3),
  reason TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  waiting_on_user BOOLEAN NOT NULL DEFAULT false,
  user_requests TEXT[] NOT NULL DEFAULT '{}',
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, agent_name, session_id)
    REFERENCES chat_sessions(workspace_id, agent_name, session_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX chat_executions_active_idx
  ON chat_executions(workspace_id, agent_name, session_id)
  WHERE state IN ('admitting', 'running', 'recovering', 'blocked');
CREATE UNIQUE INDEX chat_executions_workflow_idx
  ON chat_executions(workflow_run_uid) WHERE workflow_run_uid <> '';
CREATE INDEX chat_executions_session_idx
  ON chat_executions(workspace_id, agent_name, session_id, created_at DESC);
CREATE INDEX chat_executions_pending_idx ON chat_executions(lease_until, updated_at)
  WHERE state IN ('admitting', 'running', 'recovering', 'blocked');

CREATE TABLE chat_attempts (
  execution_id UUID NOT NULL REFERENCES chat_executions(id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number > 0),
  incarnation TEXT NOT NULL,
  state chat_attempt_state NOT NULL DEFAULT 'pending',
  message_id TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL,
  submissions INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (execution_id, number)
);

CREATE TABLE chat_execution_prompts (
  execution_id UUID NOT NULL,
  attempt INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  accepted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (execution_id, message_id),
  FOREIGN KEY (execution_id, attempt)
    REFERENCES chat_attempts(execution_id, number) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE chat_execution_prompts;
DROP TABLE chat_attempts;
DROP TABLE chat_executions;
DROP TYPE chat_protocol;
DROP TYPE chat_attempt_state;
DROP TYPE chat_execution_state;
