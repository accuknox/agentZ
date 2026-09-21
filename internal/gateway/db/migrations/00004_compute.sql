-- +goose Up

CREATE TABLE compute_hosts (
  id UUID PRIMARY KEY,
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  enrollment_hash BYTEA,
  enrollment_expires_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  workload_id TEXT NOT NULL DEFAULT '',
  node_id TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL DEFAULT '',
  work_directory TEXT NOT NULL DEFAULT '',
  revoked BOOLEAN NOT NULL DEFAULT false,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  node_expires_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  UNIQUE (tenant_namespace, agent_name),
  FOREIGN KEY (tenant_namespace, agent_name) REFERENCES agents ON DELETE CASCADE
);
CREATE UNIQUE INDEX compute_hosts_enrollment_idx ON compute_hosts(enrollment_hash) WHERE enrollment_hash IS NOT NULL;
CREATE UNIQUE INDEX compute_hosts_identity_idx ON compute_hosts(workload_id) WHERE workload_id <> '';

-- +goose Down
DROP TABLE compute_hosts;
