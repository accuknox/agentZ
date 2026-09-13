-- +goose Up
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
-- +goose Down
DROP TABLE coding_snapshots;
DROP TABLE coding_operations;
