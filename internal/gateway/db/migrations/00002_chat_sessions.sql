-- +goose Up
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE chat_session_kind AS ENUM('chat', 'workflow_run');
CREATE TYPE chat_session_status AS ENUM('idle', 'busy', 'retry');
CREATE TYPE chat_session_group_by AS ENUM('none', 'agent', 'status', 'date');

CREATE TABLE chat_sessions (
  workspace_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  parent_session_id TEXT,
  title TEXT NOT NULL,
  kind chat_session_kind NOT NULL DEFAULT 'chat',
  status chat_session_status NOT NULL DEFAULT 'idle',
  source_created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  source_updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT chat_sessions_workspace_id_agent_name_session_id_pk
    PRIMARY KEY(workspace_id, agent_name, session_id),
  CONSTRAINT chat_sessions_workspace_id_workspaces_id_fk
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT chat_sessions_agent_name_ck
    CHECK (NULLIF(BTRIM(agent_name), '') IS NOT NULL),
  CONSTRAINT chat_sessions_session_id_ck
    CHECK (NULLIF(BTRIM(session_id), '') IS NOT NULL),
  CONSTRAINT chat_sessions_title_ck
    CHECK (NULLIF(BTRIM(title), '') IS NOT NULL)
);

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

CREATE TABLE chat_session_participants (
  workspace_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  first_messaged_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  last_messaged_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT chat_session_participants_workspace_id_agent_name_session_id_user_id_pk
    PRIMARY KEY(workspace_id, agent_name, session_id, user_id),
  CONSTRAINT chat_session_participants_user_id_users_id_fk
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chat_session_participants_session_fk
    FOREIGN KEY(workspace_id, agent_name, session_id)
    REFERENCES chat_sessions(workspace_id, agent_name, session_id)
    ON DELETE CASCADE
);

CREATE INDEX chat_session_participants_user_idx
ON chat_session_participants(workspace_id, user_id);

CREATE TABLE workspace_chat_preferences (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_name TEXT,
  participant_user_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
  include_workflow_runs BOOLEAN NOT NULL DEFAULT false,
  last_agent_name TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  group_by chat_session_group_by NOT NULL DEFAULT 'none',
  CONSTRAINT workspace_chat_preferences_workspace_id_user_id_pk
    PRIMARY KEY(workspace_id, user_id),
  CONSTRAINT workspace_chat_preferences_workspace_id_workspaces_id_fk
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT workspace_chat_preferences_user_id_users_id_fk
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT workspace_chat_preferences_agent_name_ck
    CHECK (agent_name IS NULL OR NULLIF(BTRIM(agent_name), '') IS NOT NULL),
  CONSTRAINT workspace_chat_preferences_last_agent_name_ck
    CHECK (
      last_agent_name IS NULL OR NULLIF(BTRIM(last_agent_name), '') IS NOT NULL
    )
);

-- +goose Down
DROP TABLE workspace_chat_preferences;
DROP TABLE chat_session_participants;
DROP TABLE chat_sessions;
DROP TYPE chat_session_group_by;
DROP TYPE chat_session_status;
DROP TYPE chat_session_kind;

-- Other modules may use pg_trgm, so leave the extension installed.
