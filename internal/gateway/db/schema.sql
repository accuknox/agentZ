CREATE TABLE agents(
  tenant_namespace TEXT NOT NULL
    CHECK (tenant_namespace <> ''),
  agent_name TEXT NOT NULL
    CHECK (
      length(agent_name) <= 32 AND
      agent_name ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
    ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_namespace, agent_name)
);

CREATE INDEX agents_tenant_created_idx
ON agents(tenant_namespace, created_at, agent_name);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE chat_session_kind AS ENUM('chat', 'workflow_run');
CREATE TYPE chat_session_status AS ENUM('idle', 'busy', 'retry');
CREATE TYPE chat_session_group_by AS ENUM('none', 'agent', 'status', 'date', 'project');

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

CREATE TABLE coding_operations (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    organization_id text NOT NULL REFERENCES organizations(id),
    owner_id text NOT NULL REFERENCES users(id),
    project_id text NOT NULL REFERENCES coding_projects(id) ON DELETE CASCADE,
    worktree_id text NOT NULL,
    request jsonb NOT NULL,
    result jsonb NOT NULL,
    lease_token text NOT NULL DEFAULT '',
    lease_until timestamptz NOT NULL DEFAULT 'epoch',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coding_operations_actor_idx ON coding_operations(workspace_id, owner_id, created_at DESC);
CREATE INDEX coding_operations_queue_idx ON coding_operations((result->>'state'), created_at);
CREATE UNIQUE INDEX coding_operations_running_project_idx ON coding_operations(project_id)
WHERE result->>'state' = 'running';
CREATE TABLE coding_snapshots (
    project_id text NOT NULL REFERENCES coding_projects(id) ON DELETE CASCADE,
    agent_name text NOT NULL,
    worktree_id text NOT NULL DEFAULT '',
    result jsonb NOT NULL DEFAULT '{}',
    demand_until timestamptz NOT NULL DEFAULT 'epoch',
    next_refresh timestamptz NOT NULL DEFAULT now(),
    github_retry_after timestamptz NOT NULL DEFAULT 'epoch',
    next_remote timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz NOT NULL DEFAULT 'epoch',
    failures integer NOT NULL DEFAULT 0,
    generation bigint NOT NULL DEFAULT 0,
    remote_refs text NOT NULL DEFAULT '',
    PRIMARY KEY(project_id, agent_name, worktree_id)
);

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
  content JSONB NOT NULL,
  delivery TEXT NOT NULL CHECK (delivery IN ('steer', 'queue')),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'sending', 'delivered', 'failed', 'recovered', 'removed')),
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
