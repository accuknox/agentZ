-- +goose Up

CREATE TABLE workflow_run_evaluations (
  id UUID PRIMARY KEY,
  tenant_namespace TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  request JSONB NOT NULL,
  result JSONB NOT NULL,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workflow_run_evaluations_scope ON workflow_run_evaluations
  (tenant_namespace, agent_name, workflow_name, created_at DESC);
CREATE INDEX workflow_run_evaluations_pending ON workflow_run_evaluations (lease_until)
  WHERE state IN ('queued', 'running');

-- +goose Down
DROP TABLE workflow_run_evaluations;
