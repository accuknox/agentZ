-- name: WorkflowCreate :one
INSERT INTO workflows(
  tenant_namespace,
  agent_name,
  workflow_name,
  title,
  summary,
  input_schema
)
VALUES (
  sqlc.arg(tenant_namespace),
  sqlc.arg(agent_name),
  sqlc.arg(workflow_name),
  sqlc.arg(title),
  sqlc.arg(summary),
  sqlc.narg(input_schema)::jsonb
)
RETURNING
  tenant_namespace,
  agent_name,
  workflow_name,
  title,
  summary,
  input_schema,
  created_at,
  updated_at;

-- name: WorkflowCreateNodes :exec
INSERT INTO workflow_nodes(
  tenant_namespace,
  agent_name,
  workflow_name,
  node_name,
  ordinal,
  instructions,
  goal,
  done_criteria
)
SELECT
  sqlc.arg(tenant_namespace)::text,
  sqlc.arg(agent_name)::text,
  sqlc.arg(workflow_name)::text,
  n.node_name,
  n.ordinal,
  n.instructions,
  n.goal,
  n.done_criteria
FROM jsonb_to_recordset(sqlc.arg(nodes)::jsonb) AS n(
  node_name text,
  ordinal int,
  instructions text,
  goal text,
  done_criteria text
);

-- name: WorkflowCreatePreferredTools :exec
INSERT INTO workflow_node_preferred_tools(
  tenant_namespace,
  agent_name,
  workflow_name,
  node_name,
  ordinal,
  tool_name
)
SELECT
  sqlc.arg(tenant_namespace)::text,
  sqlc.arg(agent_name)::text,
  sqlc.arg(workflow_name)::text,
  t.node_name,
  t.ordinal,
  t.tool_name
FROM jsonb_to_recordset(sqlc.arg(preferred_tools)::jsonb) AS t(
  node_name text,
  ordinal int,
  tool_name text
);

-- name: WorkflowCreatePreferredSkills :exec
INSERT INTO workflow_node_preferred_skills(
  tenant_namespace,
  agent_name,
  workflow_name,
  node_name,
  ordinal,
  skill_name
)
SELECT
  sqlc.arg(tenant_namespace)::text,
  sqlc.arg(agent_name)::text,
  sqlc.arg(workflow_name)::text,
  s.node_name,
  s.ordinal,
  s.skill_name
FROM jsonb_to_recordset(sqlc.arg(preferred_skills)::jsonb) AS s(
  node_name text,
  ordinal int,
  skill_name text
);

-- name: WorkflowCreateEdges :exec
INSERT INTO workflow_edges(
  tenant_namespace,
  agent_name,
  workflow_name,
  source_node_name,
  target_node_name,
  ordinal,
  branch_label,
  condition_summary
)
SELECT
  sqlc.arg(tenant_namespace)::text,
  sqlc.arg(agent_name)::text,
  sqlc.arg(workflow_name)::text,
  e.source_node_name,
  e.target_node_name,
  e.ordinal,
  e.branch_label,
  e.condition_summary
FROM jsonb_to_recordset(sqlc.arg(edges)::jsonb) AS e(
  source_node_name text,
  target_node_name text,
  ordinal int,
  branch_label text,
  condition_summary text
);

-- name: WorkflowGet :one
SELECT
  tenant_namespace,
  agent_name,
  workflow_name,
  title,
  summary,
  input_schema,
  created_at,
  updated_at
FROM workflows
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND workflow_name = sqlc.arg(workflow_name);

-- name: WorkflowListSummaries :many
SELECT
  workflow_name,
  title,
  summary,
  updated_at
FROM workflows
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
ORDER BY updated_at DESC, workflow_name ASC;

-- name: WorkflowListExistingNames :many
SELECT workflow_name
FROM workflows
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND workflow_name = ANY(sqlc.arg(workflow_names)::text[])
ORDER BY workflow_name ASC
FOR UPDATE;

-- name: WorkflowDeleteMany :execrows
DELETE FROM workflows
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND workflow_name = ANY(sqlc.arg(workflow_names)::text[]);

-- name: WorkflowListNodes :many
SELECT
  tenant_namespace,
  agent_name,
  workflow_name,
  node_name,
  ordinal,
  instructions,
  goal,
  done_criteria,
  created_at,
  updated_at
FROM workflow_nodes
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND workflow_name = sqlc.arg(workflow_name)
ORDER BY ordinal ASC, node_name ASC;

-- name: WorkflowListPreferredTools :many
SELECT
  tenant_namespace,
  agent_name,
  workflow_name,
  node_name,
  ordinal,
  tool_name
FROM workflow_node_preferred_tools
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND workflow_name = sqlc.arg(workflow_name)
ORDER BY node_name ASC, ordinal ASC;

-- name: WorkflowListPreferredSkills :many
SELECT
  tenant_namespace,
  agent_name,
  workflow_name,
  node_name,
  ordinal,
  skill_name
FROM workflow_node_preferred_skills
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND workflow_name = sqlc.arg(workflow_name)
ORDER BY node_name ASC, ordinal ASC;

-- name: WorkflowListEdges :many
SELECT
  id,
  tenant_namespace,
  agent_name,
  workflow_name,
  source_node_name,
  target_node_name,
  ordinal,
  branch_label,
  condition_summary,
  created_at
FROM workflow_edges
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND workflow_name = sqlc.arg(workflow_name)
ORDER BY ordinal ASC, id ASC;
