CREATE TABLE workflows(
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  workflow_name TEXT NOT NULL
    CHECK (
      length(workflow_name) <= 32 AND
      workflow_name ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
    ),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  input_schema JSONB
    CHECK (
      input_schema IS NULL OR
      jsonb_typeof(input_schema) = 'object'
    ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_namespace, agent_name, workflow_name),
  FOREIGN KEY(tenant_namespace, agent_name)
    REFERENCES agents(tenant_namespace, agent_name)
    ON DELETE CASCADE
);

CREATE INDEX workflows_updated_idx
  ON workflows(
    tenant_namespace,
    agent_name,
    updated_at DESC,
    workflow_name DESC
  );

CREATE TABLE workflow_nodes(
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  node_name TEXT NOT NULL
    CHECK (
      length(node_name) <= 64 AND
      node_name ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
    ),
  ordinal INT NOT NULL CHECK(ordinal >= 0),
  instructions TEXT NOT NULL,
  goal TEXT NOT NULL,
  done_criteria TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_namespace, agent_name, workflow_name, node_name),
  FOREIGN KEY(tenant_namespace, agent_name, workflow_name)
    REFERENCES workflows(tenant_namespace, agent_name, workflow_name)
    ON DELETE CASCADE
);

CREATE INDEX workflow_nodes_workflow_ordinal_idx
  ON workflow_nodes(
    tenant_namespace,
    agent_name,
    workflow_name,
    ordinal ASC,
    node_name ASC
  );

CREATE TABLE workflow_node_preferred_tools(
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  node_name TEXT NOT NULL,
  ordinal INT NOT NULL CHECK(ordinal >= 0),
  tool_name TEXT NOT NULL,
  PRIMARY KEY(tenant_namespace, agent_name, workflow_name, node_name, ordinal),
  FOREIGN KEY(tenant_namespace, agent_name, workflow_name, node_name)
    REFERENCES workflow_nodes(
      tenant_namespace,
      agent_name,
      workflow_name,
      node_name
    )
    ON DELETE CASCADE
);

CREATE INDEX workflow_node_preferred_tools_node_idx
  ON workflow_node_preferred_tools(
    tenant_namespace,
    agent_name,
    workflow_name,
    node_name,
    ordinal ASC
  );

CREATE TABLE workflow_edges(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  source_node_name TEXT NOT NULL,
  target_node_name TEXT NOT NULL,
  ordinal INT NOT NULL CHECK(ordinal >= 0),
  branch_label TEXT NOT NULL DEFAULT '',
  condition_summary TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_namespace, agent_name, workflow_name)
    REFERENCES workflows(tenant_namespace, agent_name, workflow_name)
    ON DELETE CASCADE,
  FOREIGN KEY(tenant_namespace, agent_name, workflow_name, source_node_name)
    REFERENCES workflow_nodes(
      tenant_namespace,
      agent_name,
      workflow_name,
      node_name
    )
    ON DELETE CASCADE,
  FOREIGN KEY(tenant_namespace, agent_name, workflow_name, target_node_name)
    REFERENCES workflow_nodes(
      tenant_namespace,
      agent_name,
      workflow_name,
      node_name
    )
    ON DELETE CASCADE,
  UNIQUE(
    tenant_namespace,
    agent_name,
    workflow_name,
    source_node_name,
    target_node_name,
    ordinal
  )
);

CREATE INDEX workflow_edges_source_idx
  ON workflow_edges(
    tenant_namespace,
    agent_name,
    workflow_name,
    source_node_name,
    ordinal ASC,
    id ASC
  );

CREATE INDEX workflow_edges_target_idx
  ON workflow_edges(
    tenant_namespace,
    agent_name,
    workflow_name,
    target_node_name,
    ordinal ASC,
    id ASC
  );
