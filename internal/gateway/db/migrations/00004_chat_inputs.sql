-- +goose Up
CREATE TABLE chat_inputs (
  id UUID PRIMARY KEY,
  sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  workspace_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_name TEXT NOT NULL,
  directory TEXT NOT NULL,
  resume BOOLEAN NOT NULL DEFAULT false,
  edit_state TEXT NOT NULL DEFAULT '',
  content JSONB NOT NULL,
  delivery TEXT NOT NULL CHECK (delivery IN ('steer', 'queue')),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'editing', 'sending', 'delivered', 'failed', 'recovered', 'removed')),
  revision BIGINT NOT NULL DEFAULT 1,
  message_id TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, agent_name, session_id)
    REFERENCES chat_sessions(workspace_id, agent_name, session_id) ON DELETE CASCADE
);
CREATE INDEX chat_inputs_pending_idx ON chat_inputs(state, sequence);
CREATE TABLE chat_input_sessions (
  workspace_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  stopping BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, agent_name, session_id),
  FOREIGN KEY (workspace_id, agent_name, session_id)
    REFERENCES chat_sessions(workspace_id, agent_name, session_id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE chat_inputs;
DROP TABLE chat_input_sessions;
