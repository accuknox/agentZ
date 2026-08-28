-- +goose Up
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE chat_session_group_by AS ENUM(
  'none',
  'agent',
  'status',
  'date'
);

ALTER TABLE workspace_chat_preferences
ADD COLUMN group_by chat_session_group_by NOT NULL DEFAULT 'none';

DROP INDEX chat_sessions_inbox_idx;

CREATE INDEX chat_sessions_inbox_idx
ON chat_sessions(
  workspace_id,
  source_updated_at DESC NULLS LAST,
  agent_name,
  session_id
);

CREATE INDEX chat_sessions_agent_inbox_idx
ON chat_sessions(
  workspace_id,
  agent_name,
  source_updated_at DESC NULLS LAST,
  session_id
);

CREATE INDEX chat_sessions_status_inbox_idx
ON chat_sessions(
  workspace_id,
  status,
  source_updated_at DESC NULLS LAST,
  agent_name,
  session_id
);

CREATE INDEX chat_sessions_title_trgm_idx
ON chat_sessions USING GIN(title gin_trgm_ops);

-- +goose Down
DROP INDEX chat_sessions_title_trgm_idx;
DROP INDEX chat_sessions_status_inbox_idx;
DROP INDEX chat_sessions_agent_inbox_idx;
DROP INDEX chat_sessions_inbox_idx;

CREATE INDEX chat_sessions_inbox_idx
ON chat_sessions(
  workspace_id,
  source_updated_at,
  agent_name,
  session_id
);

ALTER TABLE workspace_chat_preferences
DROP COLUMN group_by;

DROP TYPE chat_session_group_by;

-- pg_trgm may predate this migration or support other indexes in the database.
