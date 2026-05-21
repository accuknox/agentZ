-- name: WorkflowCreate :one
INSERT INTO workflows(
  agent_name,
  workflow_name,
  title,
  summary
)
VALUES (
  sqlc.arg(agent_name),
  sqlc.arg(workflow_name),
  sqlc.arg(title),
  sqlc.arg(summary)
)
RETURNING
  agent_name,
  workflow_name,
  title,
  summary,
  created_at,
  updated_at;

-- name: WorkflowCreateNodes :exec
INSERT INTO workflow_nodes(
  agent_name,
  workflow_name,
  node_name,
  ordinal,
  instructions,
  goal,
  expected_output,
  done_criteria
)
SELECT
  sqlc.arg(agent_name)::text,
  sqlc.arg(workflow_name)::text,
  n.node_name,
  n.ordinal,
  n.instructions,
  n.goal,
  n.expected_output,
  n.done_criteria
FROM jsonb_to_recordset(sqlc.arg(nodes)::jsonb) AS n(
  node_name text,
  ordinal int,
  instructions text,
  goal text,
  expected_output text,
  done_criteria text
);

-- name: WorkflowCreatePreferredTools :exec
INSERT INTO workflow_node_preferred_tools(
  agent_name,
  workflow_name,
  node_name,
  ordinal,
  tool_name
)
SELECT
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

-- name: WorkflowCreateEdges :exec
INSERT INTO workflow_edges(
  agent_name,
  workflow_name,
  source_node_name,
  target_node_name,
  ordinal,
  branch_label,
  condition_summary,
  cel_expression
)
SELECT
  sqlc.arg(agent_name)::text,
  sqlc.arg(workflow_name)::text,
  e.source_node_name,
  e.target_node_name,
  e.ordinal,
  e.branch_label,
  e.condition_summary,
  e.cel_expression
FROM jsonb_to_recordset(sqlc.arg(edges)::jsonb) AS e(
  source_node_name text,
  target_node_name text,
  ordinal int,
  branch_label text,
  condition_summary text,
  cel_expression text
);
