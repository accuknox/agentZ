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

-- name: RunEvaluationCreate :one
INSERT INTO workflow_run_evaluations (id, tenant_namespace, workspace_id, organization_id, owner_id, agent_name, workflow_name, request, result)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
ON CONFLICT (id) DO NOTHING RETURNING *;

-- name: RunEvaluationGet :one
SELECT * FROM workflow_run_evaluations WHERE id=$1 AND tenant_namespace=$2 AND agent_name=$3 AND workflow_name=$4 AND NOT delete_requested;

-- name: RunEvaluationView :one
SELECT state, cancel_requested,
  jsonb_set(result, '{executions}',
    (SELECT jsonb_agg(CASE WHEN e->>'run_name' = sqlc.arg(transcript_run)::text
      THEN e ELSE e - ARRAY['transcript', 'run'] END
      || jsonb_strip_nulls(jsonb_build_object('run_reason',
        COALESCE(e->>'run_reason', e->'run'->>'reason'))))
     FROM jsonb_array_elements(result->'executions') AS e))::jsonb AS result
FROM workflow_run_evaluations
WHERE id=sqlc.arg(id) AND tenant_namespace=sqlc.arg(tenant_namespace)
  AND agent_name=sqlc.arg(agent_name) AND workflow_name=sqlc.arg(workflow_name)
  AND NOT delete_requested;

-- name: RunEvaluationList :many
SELECT (result - ARRAY['workflow', 'request', 'executions'] || jsonb_build_object('judge', result->'request'->'judge', 'state', CASE WHEN cancel_requested AND state <> 'cancelled' THEN 'cancelling' ELSE state END, 'executions',
  (SELECT jsonb_agg(e - ARRAY['transcript', 'run']
    || jsonb_strip_nulls(jsonb_build_object('run_reason',
      COALESCE(e->>'run_reason', e->'run'->>'reason')))) FROM jsonb_array_elements(result->'executions') AS e)))::jsonb AS summary
FROM workflow_run_evaluations WHERE tenant_namespace=$1 AND agent_name=$2 AND workflow_name=$3 AND NOT delete_requested
ORDER BY created_at DESC LIMIT 50;

-- name: RunEvaluationClaim :one
UPDATE workflow_run_evaluations SET
  lease_token=sqlc.arg(lease_token),
  lease_until=now()+interval '3 minutes'
WHERE id=(
  SELECT e.id FROM workflow_run_evaluations e
  WHERE (e.state IN ('queued','running') OR e.delete_requested)
    AND e.lease_until < now()
    AND (e.cancel_requested OR e.delete_requested)=sqlc.arg(cleanup)::boolean
  ORDER BY e.lease_until FOR UPDATE SKIP LOCKED LIMIT 1
) RETURNING *;

-- name: RunEvaluationSave :execrows
UPDATE workflow_run_evaluations SET
  result=sqlc.arg(result),
  state=CASE WHEN cancel_requested AND sqlc.arg(state)::text <> 'cancelled' THEN 'running' ELSE sqlc.arg(state)::text END,
  updated_at=now(), lease_until=now()+interval '1 second', lease_token=''
WHERE id=sqlc.arg(id) AND lease_token=sqlc.arg(lease_token);

-- name: RunEvaluationRequestDeletion :exec
UPDATE workflow_run_evaluations SET delete_requested=true, updated_at=now()
WHERE id=$1 AND tenant_namespace=$2 AND agent_name=$3 AND workflow_name=$4
  AND NOT delete_requested;

-- name: RunEvaluationDelete :execrows
DELETE FROM workflow_run_evaluations
WHERE id=$1 AND lease_token=$2 AND delete_requested;

-- name: RunEvaluationRelease :exec
UPDATE workflow_run_evaluations
SET lease_token='', lease_until=now()+interval '1 second'
WHERE id=$1 AND lease_token=$2;

-- name: RunEvaluationStopped :one
SELECT cancel_requested, delete_requested
FROM workflow_run_evaluations WHERE id=$1;

-- name: RunEvaluationRetryJudge :execrows
UPDATE workflow_run_evaluations SET result=$5, state='queued', lease_until=now(), updated_at=now()
WHERE id=$1 AND tenant_namespace=$2 AND agent_name=$3 AND workflow_name=$4 AND state='completed' AND updated_at=$6 AND NOT delete_requested;
