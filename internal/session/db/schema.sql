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
