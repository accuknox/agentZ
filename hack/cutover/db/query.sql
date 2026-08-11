-- name: GetOrganization :one
SELECT id, name, slug, created_at
FROM organizations
WHERE id = sqlc.arg(organization_id);

-- name: TryLock :one
SELECT pg_try_advisory_lock(sqlc.arg(lock_id));

-- name: Unlock :one
SELECT pg_advisory_unlock(sqlc.arg(lock_id));

-- name: ListMembers :many
SELECT
  members.id AS member_id,
  members.user_id,
  members.disabled_at,
  users.name,
  users.email,
  EXISTS (
    SELECT 1
    FROM member_roles
    JOIN role_scopes ON role_scopes.role_id = member_roles.role_id
    WHERE member_roles.member_id = members.id
      AND member_roles.organization_id = members.organization_id
      AND role_scopes.organization_id = members.organization_id
      AND role_scopes.system_role = 'superadmin'
      AND role_scopes.immutable
  ) AS superadmin,
  (SELECT count(*)::int FROM accounts WHERE accounts.user_id = users.id) AS account_count,
  (SELECT count(*)::int FROM sessions WHERE sessions.user_id = users.id) AS session_count
FROM members
JOIN users ON users.id = members.user_id
WHERE members.organization_id = sqlc.arg(organization_id)
ORDER BY members.created_at, members.id;

-- name: ListLegacyAPIKeys :many
SELECT id, config_id, name, permissions, enabled, key
FROM apikeys
WHERE reference_id = sqlc.arg(organization_id)
  AND NOT EXISTS (
    SELECT 1 FROM api_key_scopes WHERE api_key_scopes.api_key_id = apikeys.id
  )
ORDER BY created_at, id;

-- name: GetAPIKeyVerification :one
SELECT
  apikeys.key,
  apikeys.reference_id,
  apikeys.enabled,
  api_key_scopes.workspace_id,
  api_key_scopes.creator_user_id,
  (SELECT count(*)::int FROM api_key_targets WHERE api_key_id = apikeys.id) AS target_count
FROM apikeys
JOIN api_key_scopes ON api_key_scopes.api_key_id = apikeys.id
WHERE apikeys.id = sqlc.arg(api_key_id);

-- name: ListAgents :many
SELECT agent_name, created_at, updated_at
FROM agents
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
ORDER BY agent_name;

-- name: ListWorkflows :many
SELECT agent_name, workflow_name
FROM workflows
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
ORDER BY agent_name, workflow_name;

-- name: GetState :one
SELECT *
FROM tenant_cutovers
WHERE organization_id = sqlc.arg(organization_id);

-- name: ListStates :many
SELECT *
FROM tenant_cutovers
ORDER BY created_at, organization_id;

-- name: CreateState :exec
INSERT INTO tenant_cutovers(
  organization_id,
  source_namespace,
  workspace_id,
  target_namespace,
  owner_user_id,
  inventory_hash,
  backup_manifest_hash,
  inventory
)
VALUES (
  sqlc.arg(organization_id),
  sqlc.arg(source_namespace),
  sqlc.arg(workspace_id),
  sqlc.arg(target_namespace),
  sqlc.arg(owner_user_id),
  sqlc.arg(inventory_hash),
  sqlc.arg(backup_manifest_hash),
  sqlc.arg(inventory)
);

-- name: SetCheckpoint :execrows
UPDATE tenant_cutovers
SET checkpoint = sqlc.arg(next_checkpoint), updated_at = now()
WHERE organization_id = sqlc.arg(organization_id)
  AND checkpoint = sqlc.arg(expected_checkpoint)
  AND inventory_hash = sqlc.arg(inventory_hash)
  AND backup_manifest_hash = sqlc.arg(backup_manifest_hash);

-- name: MarkVerified :execrows
UPDATE tenant_cutovers
SET checkpoint = 'verified', verified_at = now(), updated_at = now()
WHERE organization_id = sqlc.arg(organization_id)
  AND checkpoint = 'kubernetes'
  AND inventory_hash = sqlc.arg(inventory_hash)
  AND backup_manifest_hash = sqlc.arg(backup_manifest_hash);

-- name: MarkActivated :execrows
UPDATE tenant_cutovers
SET checkpoint = 'activated', activated_at = now(), updated_at = now()
WHERE organization_id = sqlc.arg(organization_id)
  AND checkpoint = 'sql'
  AND verified_at IS NOT NULL
  AND inventory_hash = sqlc.arg(inventory_hash)
  AND backup_manifest_hash = sqlc.arg(backup_manifest_hash);

-- name: CreateWorkspace :exec
WITH created AS (
  INSERT INTO workspaces(
    id,
    organization_id,
    name,
    slug,
    namespace,
    state,
    provisioning_attempt
  )
  VALUES (
    sqlc.arg(id),
    sqlc.arg(organization_id),
    'Default',
    sqlc.arg(slug),
    sqlc.arg(namespace),
    'provisioning',
    1
  )
  RETURNING id, organization_id, slug
)
INSERT INTO workspace_slug_history(organization_id, workspace_id, slug)
SELECT organization_id, id, slug
FROM created;

-- name: EnsureSystemRoles :exec
WITH organization_role AS (
  INSERT INTO organization_roles(id, organization_id, role, permission)
  VALUES (
    'superadmin:' || sqlc.arg(organization_id),
    sqlc.arg(organization_id),
    'superadmin',
    '{"organization":["update","delete"],"member":["create","update","delete"],"invitation":["create","cancel"],"team":["create","update","delete"],"ac":["create","read","update","delete"]}'
  )
  ON CONFLICT (id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    role = EXCLUDED.role,
    permission = EXCLUDED.permission
  RETURNING id, organization_id
), superadmin_scope AS (
  INSERT INTO role_scopes(
    role_id,
    organization_id,
    display_name,
    system_role,
    immutable
  )
  SELECT id, organization_id, 'Superadmin', 'superadmin', TRUE
  FROM organization_role
  ON CONFLICT (role_id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    workspace_id = NULL,
    display_name = EXCLUDED.display_name,
    system_role = EXCLUDED.system_role,
    immutable = EXCLUDED.immutable
), workspace_role AS (
  INSERT INTO organization_roles(id, organization_id, role, permission)
  VALUES (
    'workspace_admin:' || sqlc.arg(workspace_id)::text,
    sqlc.arg(organization_id),
    'workspace_admin:' || sqlc.arg(workspace_id)::text,
    '{}'
  )
  ON CONFLICT (id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    role = EXCLUDED.role,
    permission = EXCLUDED.permission
  RETURNING id, organization_id
), workspace_scope AS (
  INSERT INTO role_scopes(
    role_id,
    organization_id,
    workspace_id,
    display_name,
    system_role,
    immutable
  )
  SELECT
    id,
    organization_id,
    sqlc.arg(workspace_id),
    'Workspace Admin',
    'workspace_admin',
    TRUE
  FROM workspace_role
  ON CONFLICT (role_id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    workspace_id = EXCLUDED.workspace_id,
    display_name = EXCLUDED.display_name,
    system_role = EXCLUDED.system_role,
    immutable = EXCLUDED.immutable
), promoted_member AS (
  UPDATE members
  SET role = 'superadmin'
  WHERE organization_id = sqlc.arg(organization_id)
    AND user_id = sqlc.arg(owner_user_id)
    AND disabled_at IS NULL
  RETURNING id, organization_id
)
INSERT INTO member_roles(member_id, role_id, organization_id)
SELECT
  promoted_member.id,
  'superadmin:' || promoted_member.organization_id,
  promoted_member.organization_id
FROM promoted_member
ON CONFLICT DO NOTHING;

-- name: CopyAgents :execrows
INSERT INTO agents(tenant_namespace, agent_name, created_at, updated_at)
SELECT sqlc.arg(target_namespace), agent_name, created_at, updated_at
FROM agents
WHERE agents.tenant_namespace = sqlc.arg(source_namespace)
ON CONFLICT DO NOTHING;

-- name: CopyWorkflows :execrows
INSERT INTO workflows(
  tenant_namespace,
  agent_name,
  workflow_name,
  title,
  summary,
  input_schema,
  created_at,
  updated_at
)
SELECT
  sqlc.arg(target_namespace),
  agent_name,
  workflow_name,
  title,
  summary,
  input_schema,
  created_at,
  updated_at
FROM workflows
WHERE workflows.tenant_namespace = sqlc.arg(source_namespace)
ON CONFLICT DO NOTHING;

-- name: CopyWorkflowNodes :execrows
INSERT INTO workflow_nodes(
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
)
SELECT
  sqlc.arg(target_namespace),
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
WHERE workflow_nodes.tenant_namespace = sqlc.arg(source_namespace)
ON CONFLICT DO NOTHING;

-- name: CopyWorkflowTools :execrows
INSERT INTO workflow_node_preferred_tools(
  tenant_namespace,
  agent_name,
  workflow_name,
  node_name,
  ordinal,
  tool_name
)
SELECT
  sqlc.arg(target_namespace),
  agent_name,
  workflow_name,
  node_name,
  ordinal,
  tool_name
FROM workflow_node_preferred_tools
WHERE workflow_node_preferred_tools.tenant_namespace = sqlc.arg(source_namespace)
ON CONFLICT DO NOTHING;

-- name: CopyWorkflowSkills :execrows
INSERT INTO workflow_node_preferred_skills(
  tenant_namespace,
  agent_name,
  workflow_name,
  node_name,
  ordinal,
  skill_name
)
SELECT
  sqlc.arg(target_namespace),
  agent_name,
  workflow_name,
  node_name,
  ordinal,
  skill_name
FROM workflow_node_preferred_skills
WHERE workflow_node_preferred_skills.tenant_namespace = sqlc.arg(source_namespace)
ON CONFLICT DO NOTHING;

-- name: CopyWorkflowEdges :execrows
INSERT INTO workflow_edges(
  tenant_namespace,
  agent_name,
  workflow_name,
  source_node_name,
  target_node_name,
  ordinal,
  branch_label,
  condition_summary,
  created_at
)
SELECT
  sqlc.arg(target_namespace),
  agent_name,
  workflow_name,
  source_node_name,
  target_node_name,
  ordinal,
  branch_label,
  condition_summary,
  created_at
FROM workflow_edges
WHERE workflow_edges.tenant_namespace = sqlc.arg(source_namespace)
ON CONFLICT DO NOTHING;

-- name: MoveProcessEvents :execrows
UPDATE observer_process_events
SET
  tenant_namespace = sqlc.arg(target_namespace),
  pod_namespace = CASE
    WHEN pod_namespace = sqlc.arg(source_namespace) THEN sqlc.arg(target_namespace)
    ELSE pod_namespace
  END
WHERE tenant_namespace = sqlc.arg(source_namespace);

-- name: MoveFileEvents :execrows
UPDATE observer_file_events
SET
  tenant_namespace = sqlc.arg(target_namespace),
  pod_namespace = CASE
    WHEN pod_namespace = sqlc.arg(source_namespace) THEN sqlc.arg(target_namespace)
    ELSE pod_namespace
  END
WHERE tenant_namespace = sqlc.arg(source_namespace);

-- name: MoveNetworkEvents :execrows
UPDATE observer_network_events
SET
  tenant_namespace = sqlc.arg(target_namespace),
  pod_namespace = CASE
    WHEN pod_namespace = sqlc.arg(source_namespace) THEN sqlc.arg(target_namespace)
    ELSE pod_namespace
  END
WHERE tenant_namespace = sqlc.arg(source_namespace);

-- name: MoveTraces :execrows
UPDATE observer_traces
SET tenant_namespace = sqlc.arg(target_namespace)
WHERE tenant_namespace = sqlc.arg(source_namespace);

-- name: MoveTraceSessions :execrows
UPDATE observer_trace_sessions
SET tenant_namespace = sqlc.arg(target_namespace)
WHERE tenant_namespace = sqlc.arg(source_namespace);

-- name: MoveTraceSpans :execrows
UPDATE observer_trace_spans
SET tenant_namespace = sqlc.arg(target_namespace)
WHERE tenant_namespace = sqlc.arg(source_namespace);

-- name: MoveMCPInvocations :execrows
UPDATE observer_mcp_tool_invocations
SET tenant_namespace = sqlc.arg(target_namespace)
WHERE tenant_namespace = sqlc.arg(source_namespace);

-- name: MoveMCPLastCalled :execrows
UPDATE observer_mcp_tool_last_called
SET tenant_namespace = sqlc.arg(target_namespace)
WHERE tenant_namespace = sqlc.arg(source_namespace);

-- name: EnsureAgentOwners :execrows
INSERT INTO agent_owners(
  organization_id,
  workspace_id,
  agent_name,
  creator_user_id,
  owner_user_id
)
SELECT
  sqlc.arg(organization_id),
  sqlc.arg(workspace_id),
  agents.agent_name,
  sqlc.arg(owner_user_id),
  sqlc.arg(owner_user_id)
FROM agents
WHERE agents.tenant_namespace = sqlc.arg(target_namespace)
ON CONFLICT DO NOTHING;

-- name: SetDefaultWorkspaceContexts :execrows
INSERT INTO last_accessible_contexts(
  user_id,
  organization_id,
  workspace_id,
  route
)
SELECT
  members.user_id,
  members.organization_id,
  sqlc.arg(workspace_id),
  sqlc.arg(route)
FROM members
WHERE members.organization_id = sqlc.arg(organization_id)
  AND members.disabled_at IS NULL
ON CONFLICT (user_id, organization_id) DO UPDATE SET
  workspace_id = EXCLUDED.workspace_id,
  route = EXCLUDED.route,
  updated_at = now();

-- name: EnsureAPIKeyScope :execrows
INSERT INTO api_key_scopes(
  api_key_id,
  organization_id,
  workspace_id,
  creator_user_id
)
SELECT
  apikeys.id,
  sqlc.arg(organization_id),
  sqlc.arg(workspace_id),
  sqlc.arg(owner_user_id)
FROM apikeys
WHERE apikeys.id = sqlc.arg(api_key_id)
  AND apikeys.reference_id = sqlc.arg(organization_id)
ON CONFLICT DO NOTHING;

-- name: EnsureAPIKeyTarget :execrows
INSERT INTO api_key_targets(api_key_id, target_type, agent_name, workflow_name)
VALUES (
  sqlc.arg(api_key_id),
  sqlc.arg(target_type),
  sqlc.arg(agent_name),
  sqlc.arg(workflow_name)
)
ON CONFLICT DO NOTHING;

-- name: CountNamespaceRows :one
SELECT
  (SELECT count(*)::int FROM agents a WHERE a.tenant_namespace = sqlc.arg(scope_namespace)) AS agents,
  (SELECT count(*)::int FROM workflows w WHERE w.tenant_namespace = sqlc.arg(scope_namespace)) AS workflows,
  (SELECT count(*)::int FROM workflow_nodes wn WHERE wn.tenant_namespace = sqlc.arg(scope_namespace)) AS workflow_nodes,
  (SELECT count(*)::int FROM workflow_node_preferred_tools wnpt WHERE wnpt.tenant_namespace = sqlc.arg(scope_namespace)) AS workflow_tools,
  (SELECT count(*)::int FROM workflow_node_preferred_skills wnps WHERE wnps.tenant_namespace = sqlc.arg(scope_namespace)) AS workflow_skills,
  (SELECT count(*)::int FROM workflow_edges we WHERE we.tenant_namespace = sqlc.arg(scope_namespace)) AS workflow_edges,
  (SELECT count(*)::int FROM observer_process_events ope WHERE ope.tenant_namespace = sqlc.arg(scope_namespace)) AS process_events,
  (SELECT count(*)::int FROM observer_file_events ofe WHERE ofe.tenant_namespace = sqlc.arg(scope_namespace)) AS file_events,
  (SELECT count(*)::int FROM observer_network_events one WHERE one.tenant_namespace = sqlc.arg(scope_namespace)) AS network_events,
  (SELECT count(*)::int FROM observer_traces ot WHERE ot.tenant_namespace = sqlc.arg(scope_namespace)) AS traces,
  (SELECT count(*)::int FROM observer_trace_sessions ots WHERE ots.tenant_namespace = sqlc.arg(scope_namespace)) AS trace_sessions,
  (SELECT count(*)::int FROM observer_trace_spans otsp WHERE otsp.tenant_namespace = sqlc.arg(scope_namespace)) AS trace_spans,
  (SELECT count(*)::int FROM observer_mcp_tool_invocations omti WHERE omti.tenant_namespace = sqlc.arg(scope_namespace)) AS mcp_invocations,
  (SELECT count(*)::int FROM observer_mcp_tool_last_called omtlc WHERE omtlc.tenant_namespace = sqlc.arg(scope_namespace)) AS mcp_last_called;

-- name: DeleteSourceWorkflows :execrows
DELETE FROM workflows
WHERE tenant_namespace = sqlc.arg(source_namespace);

-- name: DeleteSourceAgents :execrows
DELETE FROM agents
WHERE tenant_namespace = sqlc.arg(source_namespace);

-- name: CreateAuditEvent :exec
INSERT INTO audit_events(
  id,
  organization_id,
  workspace_id,
  actor_type,
  target_type,
  target_id,
  category,
  action,
  result,
  automatic_cascade,
  interface,
  after
)
VALUES (
  sqlc.arg(id),
  sqlc.arg(organization_id),
  sqlc.arg(workspace_id),
  'system',
  'workspace',
  sqlc.arg(workspace_id),
  'cutover',
  'tenant.cutover',
  'succeeded',
  TRUE,
  'system',
  sqlc.arg(after)
);
