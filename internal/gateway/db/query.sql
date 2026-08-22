-- name: GatewayAgentExists :one
SELECT EXISTS(
  SELECT 1
  FROM agents
  WHERE tenant_namespace = $1
    AND agent_name = $2
);

-- name: GatewayGetAPIKeyByHash :one
SELECT id, reference_id, name
FROM apikeys
WHERE key = sqlc.arg(key)
  AND config_id = sqlc.arg(config_id)
  AND enabled = true
  AND (
    expires_at IS NULL
    OR expires_at > sqlc.arg(now_at)
  );

-- name: GatewayCreateAgent :one
INSERT INTO agents(tenant_namespace, agent_name)
VALUES ($1, $2)
RETURNING tenant_namespace, agent_name, created_at, updated_at;

-- name: GatewayGetAgent :one
SELECT tenant_namespace, agent_name, created_at, updated_at
FROM agents
WHERE tenant_namespace = $1
  AND agent_name = $2;

-- name: GatewayTouchAgent :one
UPDATE agents
SET updated_at = sqlc.arg(updated_at)
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
RETURNING tenant_namespace, agent_name, created_at, updated_at;

-- name: GatewayDeleteAgent :execrows
DELETE FROM agents
WHERE tenant_namespace = $1
  AND agent_name = $2;

-- name: GatewayDeleteWorkspaceAgents :execrows
DELETE FROM agents
WHERE tenant_namespace = $1;

-- name: GatewayListDashboards :many
SELECT
  id,
  agent_name,
  name,
  revision,
  definition,
  created_at,
  updated_at
FROM dashboards
WHERE workspace_id = sqlc.arg(workspace_id)
  AND (
    NOT sqlc.arg(agent_filter_set)::boolean
    OR agent_name = sqlc.arg(agent_name)
  )
  AND (
    NOT sqlc.arg(cursor_set)::boolean
    OR (updated_at, id) < (
      sqlc.arg(cursor_updated_at),
      sqlc.arg(cursor_id)::text
    )
  )
ORDER BY updated_at DESC, id DESC
LIMIT sqlc.arg(page_size);

-- name: GatewayGetDashboardByID :one
SELECT id, agent_name, name, revision, definition, created_at, updated_at
FROM dashboards
WHERE workspace_id = sqlc.arg(workspace_id)
  AND id = sqlc.arg(id);

-- name: GatewayGetAgentDashboard :one
SELECT id, agent_name, name, revision, definition, created_at, updated_at
FROM dashboards
WHERE workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name)
  AND name = sqlc.arg(name);

-- name: GatewayCreateDashboard :one
INSERT INTO dashboards(
  id,
  organization_id,
  workspace_id,
  agent_name,
  name,
  definition
)
VALUES (
  sqlc.arg(id),
  sqlc.arg(organization_id),
  sqlc.arg(workspace_id),
  sqlc.arg(agent_name),
  sqlc.arg(name),
  sqlc.arg(definition)
)
RETURNING id, agent_name, name, revision, definition, created_at, updated_at;

-- name: GatewayReplaceDashboard :one
UPDATE dashboards
SET
  name = sqlc.arg(next_name),
  definition = sqlc.arg(definition),
  revision = revision + 1,
  updated_at = NOW()
WHERE workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name)
  AND name = sqlc.arg(name)
  AND revision = sqlc.arg(expected_revision)
RETURNING id, agent_name, name, revision, definition, created_at, updated_at;

-- name: GatewayDeleteDashboard :execrows
DELETE FROM dashboards
WHERE workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name)
  AND name = sqlc.arg(name);

-- name: GatewayGetDashboardSessionKind :one
SELECT kind
FROM chat_sessions
WHERE workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name)
  AND session_id = sqlc.arg(session_id);

-- name: GatewayAppendDashboardRecords :execrows
INSERT INTO dashboard_records(
  id,
  dashboard_id,
  workspace_id,
  record_key,
  session_id,
  observed_at,
  expires_at,
  dimensions,
  measures
)
SELECT
  record.id,
  sqlc.arg(dashboard_id),
  sqlc.arg(workspace_id),
  record.record_key,
  sqlc.arg(session_id),
  record.observed_at,
  NOW() + INTERVAL '30 days',
  record.dimensions,
  record.measures
FROM jsonb_to_recordset(sqlc.arg(records)) AS record(
  id text,
  record_key text,
  observed_at timestamptz,
  dimensions jsonb,
  measures jsonb
)
ON CONFLICT DO NOTHING;

-- name: GatewayUpsertDashboardRecords :execrows
INSERT INTO dashboard_records(
  id,
  dashboard_id,
  workspace_id,
  record_key,
  session_id,
  observed_at,
  expires_at,
  dimensions,
  measures
)
SELECT
  record.id,
  sqlc.arg(dashboard_id),
  sqlc.arg(workspace_id),
  record.record_key,
  sqlc.arg(session_id),
  record.observed_at,
  NOW() + INTERVAL '30 days',
  record.dimensions,
  record.measures
FROM jsonb_to_recordset(sqlc.arg(records)) AS record(
  id text,
  record_key text,
  observed_at timestamptz,
  dimensions jsonb,
  measures jsonb
)
ON CONFLICT (dashboard_id, record_key) WHERE record_key IS NOT NULL DO UPDATE SET
  session_id = EXCLUDED.session_id,
  observed_at = EXCLUDED.observed_at,
  dimensions = EXCLUDED.dimensions,
  measures = EXCLUDED.measures,
  updated_at = NOW(),
  expires_at = NOW() + INTERVAL '30 days';

-- name: GatewayDeleteDashboardRecords :execrows
DELETE FROM dashboard_records
WHERE dashboard_id = sqlc.arg(dashboard_id)
  AND workspace_id = sqlc.arg(workspace_id)
  AND record_key = ANY(sqlc.arg(record_keys)::text[]);

-- name: GatewayConsumeDashboardRateLimit :one
INSERT INTO dashboard_rate_limits(key, window_started_at, count)
VALUES (sqlc.arg(key), sqlc.arg(window_started_at), sqlc.arg(delta))
ON CONFLICT (key, window_started_at) DO UPDATE SET
  count = dashboard_rate_limits.count + EXCLUDED.count
WHERE dashboard_rate_limits.count + EXCLUDED.count <= sqlc.arg(max_count)
RETURNING count;

-- name: GatewayDeleteExpiredDashboardRecords :execrows
WITH expired AS (
  SELECT dashboard_id, id
  FROM dashboard_records
  WHERE expires_at <= NOW()
  ORDER BY expires_at
  LIMIT sqlc.arg(batch_size)
  FOR UPDATE SKIP LOCKED
)
DELETE FROM dashboard_records AS records
USING expired
WHERE records.dashboard_id = expired.dashboard_id
  AND records.id = expired.id;

-- name: GatewayDeleteExpiredDashboardRateLimits :execrows
DELETE FROM dashboard_rate_limits
WHERE window_started_at < sqlc.arg(retained_after);

-- name: GatewaySetDashboardQueryTimeout :exec
SET LOCAL statement_timeout = '2s';

-- name: GatewayAcquireDashboardQuerySlot :one
SELECT slot::integer
FROM generate_series(0, 7) AS slots(slot)
WHERE pg_try_advisory_xact_lock(
  hashtextextended(sqlc.arg(workspace_id)::text, slot::bigint)
)
LIMIT 1;

-- name: GatewayListDashboardFilterOptions :many
SELECT DISTINCT (records.dimensions ->> sqlc.arg(field)::text)::text AS value
FROM dashboard_records AS records
WHERE records.workspace_id = sqlc.arg(workspace_id)
  AND records.dashboard_id = sqlc.arg(dashboard_id)
  AND records.observed_at >= sqlc.arg(observed_after)
  AND records.observed_at < sqlc.arg(observed_before)
  AND records.expires_at > NOW()
  AND records.dimensions ? sqlc.arg(field)::text
ORDER BY value
LIMIT 100;

-- name: GatewayQueryDashboardMetric :one
SELECT COALESCE(
  CASE sqlc.arg(aggregation)::text
    WHEN 'avg' THEN AVG(NULLIF(records.measures ->> sqlc.arg(measure)::text, '')::double precision)
    WHEN 'count' THEN COUNT(NULLIF(records.measures ->> sqlc.arg(measure)::text, ''))::double precision
    WHEN 'max' THEN MAX(NULLIF(records.measures ->> sqlc.arg(measure)::text, '')::double precision)
    WHEN 'min' THEN MIN(NULLIF(records.measures ->> sqlc.arg(measure)::text, '')::double precision)
    WHEN 'sum' THEN SUM(NULLIF(records.measures ->> sqlc.arg(measure)::text, '')::double precision)
  END,
  0
)::double precision AS value
FROM dashboard_records AS records
WHERE records.workspace_id = sqlc.arg(workspace_id)
  AND records.dashboard_id = sqlc.arg(dashboard_id)
  AND records.observed_at >= sqlc.arg(observed_after)
  AND records.observed_at < sqlc.arg(observed_before)
  AND records.expires_at > NOW()
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(sqlc.arg(filters)::jsonb) AS selected(field text, values text[])
    WHERE cardinality(selected.values) > 0
      AND NOT COALESCE(
        records.dimensions ->> selected.field = ANY(selected.values),
        false
      )
  );

-- name: GatewayQueryDashboardTimeSeries :many
WITH filtered AS MATERIALIZED (
  SELECT
    records.observed_at,
    CASE
      WHEN sqlc.arg(grouped)::boolean
        THEN COALESCE(records.dimensions ->> sqlc.arg(group_by)::text, 'Unknown')
      ELSE 'All'
    END::text AS label,
    NULLIF(records.measures ->> sqlc.arg(measure)::text, '')::double precision AS value
  FROM dashboard_records AS records
  WHERE records.workspace_id = sqlc.arg(workspace_id)
    AND records.dashboard_id = sqlc.arg(dashboard_id)
    AND records.observed_at >= sqlc.arg(observed_after)
    AND records.observed_at < sqlc.arg(observed_before)
    AND records.expires_at > NOW()
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(sqlc.arg(filters)::jsonb) AS selected(field text, values text[])
      WHERE cardinality(selected.values) > 0
        AND NOT COALESCE(
          records.dimensions ->> selected.field = ANY(selected.values),
          false
        )
    )
), top_series AS (
  SELECT
    filtered.label,
    COALESCE(
      CASE sqlc.arg(aggregation)::text
        WHEN 'avg' THEN AVG(filtered.value)
        WHEN 'count' THEN COUNT(filtered.value)::double precision
        WHEN 'max' THEN MAX(filtered.value)
        WHEN 'min' THEN MIN(filtered.value)
        WHEN 'sum' THEN SUM(filtered.value)
      END,
      0
    )::double precision AS score
  FROM filtered
  GROUP BY filtered.label
  ORDER BY score DESC, filtered.label
  LIMIT sqlc.arg(series_limit)
)
SELECT
  date_bin(
    make_interval(secs => sqlc.arg(bucket_seconds)::integer),
    filtered.observed_at,
    timestamptz 'epoch'
  )::timestamptz AS bucket,
  filtered.label,
  COALESCE(
    CASE sqlc.arg(aggregation)::text
      WHEN 'avg' THEN AVG(filtered.value)
      WHEN 'count' THEN COUNT(filtered.value)::double precision
      WHEN 'max' THEN MAX(filtered.value)
      WHEN 'min' THEN MIN(filtered.value)
      WHEN 'sum' THEN SUM(filtered.value)
    END,
    0
  )::double precision AS value
FROM filtered
INNER JOIN top_series ON top_series.label = filtered.label
GROUP BY bucket, filtered.label
ORDER BY bucket, filtered.label
LIMIT sqlc.arg(row_limit);

-- name: GatewayQueryDashboardDonut :many
SELECT
  COALESCE(records.dimensions ->> sqlc.arg(group_by)::text, 'Unknown')::text AS label,
  COALESCE(
    CASE sqlc.arg(aggregation)::text
      WHEN 'avg' THEN AVG(NULLIF(records.measures ->> sqlc.arg(measure)::text, '')::double precision)
      WHEN 'count' THEN COUNT(NULLIF(records.measures ->> sqlc.arg(measure)::text, ''))::double precision
      WHEN 'max' THEN MAX(NULLIF(records.measures ->> sqlc.arg(measure)::text, '')::double precision)
      WHEN 'min' THEN MIN(NULLIF(records.measures ->> sqlc.arg(measure)::text, '')::double precision)
      WHEN 'sum' THEN SUM(NULLIF(records.measures ->> sqlc.arg(measure)::text, '')::double precision)
    END,
    0
  )::double precision AS value
FROM dashboard_records AS records
WHERE records.workspace_id = sqlc.arg(workspace_id)
  AND records.dashboard_id = sqlc.arg(dashboard_id)
  AND records.observed_at >= sqlc.arg(observed_after)
  AND records.observed_at < sqlc.arg(observed_before)
  AND records.expires_at > NOW()
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(sqlc.arg(filters)::jsonb) AS selected(field text, values text[])
    WHERE cardinality(selected.values) > 0
      AND NOT COALESCE(
        records.dimensions ->> selected.field = ANY(selected.values),
        false
      )
  )
GROUP BY label
ORDER BY value DESC, label
LIMIT sqlc.arg(row_limit);

-- name: GatewayQueryDashboardTable :many
SELECT ARRAY(
  SELECT CASE
    WHEN selected.column_name = ANY(sqlc.arg(dimension_fields)::text[])
      THEN COALESCE(records.dimensions ->> selected.column_name, '')
    ELSE COALESCE(records.measures ->> selected.column_name, '')
  END
  FROM unnest(sqlc.arg(columns)::text[]) WITH ORDINALITY AS selected(column_name, position)
  ORDER BY selected.position
)::text[] AS cells
FROM dashboard_records AS records
WHERE records.workspace_id = sqlc.arg(workspace_id)
  AND records.dashboard_id = sqlc.arg(dashboard_id)
  AND records.observed_at >= sqlc.arg(observed_after)
  AND records.observed_at < sqlc.arg(observed_before)
  AND records.expires_at > NOW()
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(sqlc.arg(filters)::jsonb) AS selected(field text, values text[])
    WHERE cardinality(selected.values) > 0
      AND NOT COALESCE(
        records.dimensions ->> selected.field = ANY(selected.values),
        false
      )
  )
ORDER BY
  CASE
    WHEN NOT sqlc.arg(sort_set)::boolean THEN records.observed_at
  END DESC,
  CASE
    WHEN sqlc.arg(sort_set)::boolean
      AND sqlc.arg(sort_dimension)::boolean
      AND NOT sqlc.arg(sort_descending)::boolean
      THEN records.dimensions ->> sqlc.arg(sort_by)::text
  END ASC NULLS LAST,
  CASE
    WHEN sqlc.arg(sort_set)::boolean
      AND sqlc.arg(sort_dimension)::boolean
      AND sqlc.arg(sort_descending)::boolean
      THEN records.dimensions ->> sqlc.arg(sort_by)::text
  END DESC NULLS LAST,
  CASE
    WHEN sqlc.arg(sort_set)::boolean
      AND NOT sqlc.arg(sort_dimension)::boolean
      AND NOT sqlc.arg(sort_descending)::boolean
      THEN NULLIF(records.measures ->> sqlc.arg(sort_by)::text, '')::double precision
  END ASC NULLS LAST,
  CASE
    WHEN sqlc.arg(sort_set)::boolean
      AND NOT sqlc.arg(sort_dimension)::boolean
      AND sqlc.arg(sort_descending)::boolean
      THEN NULLIF(records.measures ->> sqlc.arg(sort_by)::text, '')::double precision
  END DESC NULLS LAST,
  records.observed_at DESC,
  records.id DESC
LIMIT sqlc.arg(row_limit);

-- name: GatewayCreateDashboardIntegrationFixture :exec
WITH test_organization AS (
  INSERT INTO organizations(id, name, slug, created_at)
  VALUES (
    sqlc.arg(organization_id),
    'Dashboard test',
    sqlc.arg(organization_slug),
    NOW()
  )
  RETURNING id
), test_user AS (
  INSERT INTO users(id, name, email)
  VALUES (
    sqlc.arg(user_id),
    'Dashboard test',
    sqlc.arg(user_email)
  )
  RETURNING id
), test_workspace AS (
  INSERT INTO workspaces(
    id,
    organization_id,
    name,
    slug,
    namespace,
    state
  )
  SELECT
    sqlc.arg(workspace_id),
    test_organization.id,
    'Dashboard test',
    sqlc.arg(workspace_slug),
    sqlc.arg(workspace_namespace),
    'ready'
  FROM test_organization
  RETURNING id, organization_id
), test_owner AS (
  INSERT INTO agent_owners(
    organization_id,
    workspace_id,
    agent_name,
    creator_user_id,
    owner_user_id
  )
  SELECT
    test_workspace.organization_id,
    test_workspace.id,
    sqlc.arg(agent_name),
    test_user.id,
    test_user.id
  FROM test_workspace
  CROSS JOIN test_user
  RETURNING workspace_id, agent_name
)
INSERT INTO chat_sessions(
  workspace_id,
  agent_name,
  session_id,
  title,
  kind,
  status,
  source_created_at,
  source_updated_at
)
SELECT
  test_owner.workspace_id,
  test_owner.agent_name,
  sqlc.arg(session_id),
  'Dashboard test',
  'chat',
  'idle',
  NOW(),
  NOW()
FROM test_owner;

-- name: GatewayDeleteDashboardIntegrationFixture :exec
WITH deleted_events AS (
  DELETE FROM event_trail_events AS events
  WHERE events.organization_id = sqlc.arg(organization_id)
  RETURNING 1
), deleted_owners AS (
  DELETE FROM agent_owners AS owners
  WHERE owners.workspace_id = sqlc.arg(workspace_id)
  RETURNING 1
), deleted_workspace AS (
  DELETE FROM workspaces AS workspace
  WHERE workspace.id = sqlc.arg(workspace_id)
  RETURNING 1
), deleted_organization AS (
  DELETE FROM organizations AS organization
  WHERE organization.id = sqlc.arg(organization_id)
  RETURNING 1
)
DELETE FROM users
WHERE users.id = sqlc.arg(user_id);

-- name: GatewayExpireDashboardIntegrationRecords :execrows
UPDATE dashboard_records
SET
  ingested_at = NOW() - INTERVAL '31 days',
  expires_at = NOW() - INTERVAL '1 day'
WHERE dashboard_id = sqlc.arg(dashboard_id);

-- name: GatewayCountDashboardIntegrationAuditEvents :one
SELECT COUNT(*)
FROM event_trail_events
WHERE organization_id = sqlc.arg(organization_id)
  AND target_type = 'dashboard';

-- name: GatewayMarkDashboardIntegrationSessionAsWorkflowRun :execrows
UPDATE chat_sessions
SET kind = 'workflow_run'
WHERE workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name)
  AND session_id = sqlc.arg(session_id);

-- name: GatewayDeleteSessionTraces :execrows
DELETE FROM observer_traces ot
WHERE ot.tenant_namespace = sqlc.arg(tenant_namespace)
  AND ot.agent_name = sqlc.arg(agent_name)
  AND ot.trace_id IN (
    SELECT ots.trace_id
    FROM observer_trace_sessions ots
    WHERE ots.tenant_namespace = sqlc.arg(tenant_namespace)
      AND ots.agent_name = sqlc.arg(agent_name)
      AND ots.session_id = sqlc.arg(session_id)
  );

-- name: GatewayUpsertChatSession :exec
WITH changed AS (
INSERT INTO chat_sessions(
  workspace_id,
  agent_name,
  session_id,
  parent_session_id,
  title,
  kind,
  status,
  source_created_at,
  source_updated_at
)
VALUES (
  sqlc.arg(workspace_id),
  sqlc.arg(agent_name),
  sqlc.arg(session_id),
  sqlc.narg(parent_session_id),
  sqlc.arg(title),
  sqlc.arg(kind),
  sqlc.arg(status),
  sqlc.arg(source_created_at),
  sqlc.arg(source_updated_at)
)
ON CONFLICT (workspace_id, agent_name, session_id) DO UPDATE SET
  -- Gateway participant activity can be newer than OpenCode's session time,
  -- and generated titles do not advance that time.
  parent_session_id = EXCLUDED.parent_session_id,
  title = EXCLUDED.title,
  kind = chat_sessions.kind,
  status = chat_sessions.status,
  source_created_at = EXCLUDED.source_created_at,
  source_updated_at = GREATEST(
    chat_sessions.source_updated_at,
    EXCLUDED.source_updated_at
  ),
  updated_at = NOW()
WHERE ROW(
  chat_sessions.parent_session_id,
  chat_sessions.title,
  chat_sessions.source_created_at,
  chat_sessions.source_updated_at
) IS DISTINCT FROM ROW(
  EXCLUDED.parent_session_id,
  EXCLUDED.title,
  EXCLUDED.source_created_at,
  GREATEST(chat_sessions.source_updated_at, EXCLUDED.source_updated_at)
)
RETURNING workspace_id
)
SELECT pg_notify('agentz_chat_sessions', workspace_id)
FROM changed;

-- name: GatewaySyncAgentChatSessionStatuses :exec
WITH changed AS (
UPDATE chat_sessions
SET
  status = (CASE
    WHEN session_id = ANY(sqlc.arg(retry_session_ids)::text[]) THEN 'retry'
    WHEN session_id = ANY(sqlc.arg(busy_session_ids)::text[]) THEN 'busy'
    ELSE 'idle'
  END)::chat_session_status,
  updated_at = NOW()
WHERE workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name)
  AND status IS DISTINCT FROM (CASE
    WHEN session_id = ANY(sqlc.arg(retry_session_ids)::text[]) THEN 'retry'
    WHEN session_id = ANY(sqlc.arg(busy_session_ids)::text[]) THEN 'busy'
    ELSE 'idle'
  END)::chat_session_status
RETURNING workspace_id
)
SELECT pg_notify('agentz_chat_sessions', workspace_id)
FROM changed
GROUP BY workspace_id;

-- name: GatewayTouchChatSessionParticipant :exec
WITH participant AS (
INSERT INTO chat_session_participants(
  workspace_id,
  agent_name,
  session_id,
  user_id,
  first_messaged_at,
  last_messaged_at
)
VALUES (
  sqlc.arg(workspace_id),
  sqlc.arg(agent_name),
  sqlc.arg(session_id),
  sqlc.arg(user_id),
  sqlc.arg(messaged_at),
  sqlc.arg(messaged_at)
)
ON CONFLICT (workspace_id, agent_name, session_id, user_id) DO UPDATE SET
  last_messaged_at = GREATEST(
    chat_session_participants.last_messaged_at,
    EXCLUDED.last_messaged_at
  )
RETURNING 1
), changed AS (
UPDATE chat_sessions AS sessions
SET
  status = sqlc.arg(status),
  source_updated_at = GREATEST(sessions.source_updated_at, sqlc.arg(messaged_at)),
  updated_at = NOW()
WHERE sessions.workspace_id = sqlc.arg(workspace_id)
  AND sessions.agent_name = sqlc.arg(agent_name)
  AND sessions.session_id = sqlc.arg(session_id)
  AND EXISTS (SELECT 1 FROM participant)
RETURNING sessions.workspace_id
)
SELECT pg_notify('agentz_chat_sessions', workspace_id)
FROM changed;

-- name: GatewayDeleteChatSession :exec
WITH changed AS (
DELETE FROM chat_sessions
WHERE workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name)
  AND session_id = sqlc.arg(session_id)
RETURNING workspace_id
)
SELECT pg_notify('agentz_chat_sessions', workspace_id)
FROM changed;

-- name: GatewayDeleteAgentChatSessions :exec
WITH changed AS (
DELETE FROM chat_sessions
WHERE workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name)
RETURNING workspace_id
)
SELECT pg_notify('agentz_chat_sessions', workspace_id)
FROM changed
GROUP BY workspace_id;

-- name: GatewayClearAgentChatPreferences :exec
UPDATE workspace_chat_preferences
SET
  agent_name = CASE
    WHEN agent_name = sqlc.arg(agent_name)::text THEN NULL
    ELSE agent_name
  END,
  last_agent_name = CASE
    WHEN last_agent_name = sqlc.arg(agent_name)::text THEN NULL
    ELSE last_agent_name
  END,
  updated_at = NOW()
WHERE workspace_id = sqlc.arg(workspace_id)
  AND (
    agent_name = sqlc.arg(agent_name)::text
    OR last_agent_name = sqlc.arg(agent_name)::text
  );

-- name: GatewayListChatSessions :many
SELECT
  sessions.workspace_id,
  sessions.agent_name,
  sessions.session_id,
  sessions.title,
  sessions.kind,
  sessions.status,
  sessions.source_created_at,
  sessions.source_updated_at,
  COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', users.id,
        'name', users.name,
        'email', users.email,
        'image', users.image
      )
      ORDER BY participants.last_messaged_at DESC, users.id
    )
    FROM chat_session_participants AS participants
    JOIN users ON users.id = participants.user_id
    WHERE participants.workspace_id = sessions.workspace_id
      AND participants.agent_name = sessions.agent_name
      AND participants.session_id = sessions.session_id
  ), '[]'::jsonb)::text AS participants_json
FROM chat_sessions AS sessions
WHERE sessions.workspace_id = sqlc.arg(workspace_id)
  AND sessions.agent_name = ANY(sqlc.arg(agent_names)::text[])
  AND sessions.parent_session_id IS NULL
  AND (
    sqlc.arg(include_workflow_runs)::boolean
    OR sessions.kind <> 'workflow_run'
  )
  AND (
    sqlc.narg(agent_name)::text IS NULL
    OR sessions.agent_name = sqlc.narg(agent_name)::text
  )
  AND (
    cardinality(sqlc.arg(participant_user_ids)::text[]) = 0
    OR (
      SELECT COUNT(DISTINCT participants.user_id)
      FROM chat_session_participants AS participants
      WHERE participants.workspace_id = sessions.workspace_id
        AND participants.agent_name = sessions.agent_name
        AND participants.session_id = sessions.session_id
        AND participants.user_id = ANY(sqlc.arg(participant_user_ids)::text[])
    ) = cardinality(sqlc.arg(participant_user_ids)::text[])
  )
  AND (
    NOT sqlc.arg(cursor_set)::boolean
    OR sessions.source_updated_at < sqlc.arg(cursor_updated_at)
    OR (
      sessions.source_updated_at = sqlc.arg(cursor_updated_at)
      AND sessions.agent_name > sqlc.arg(cursor_agent_name)
    )
    OR (
      sessions.source_updated_at = sqlc.arg(cursor_updated_at)
      AND sessions.agent_name = sqlc.arg(cursor_agent_name)
      AND sessions.session_id > sqlc.arg(cursor_session_id)
    )
  )
ORDER BY
  sessions.source_updated_at DESC,
  sessions.agent_name ASC,
  sessions.session_id ASC
LIMIT sqlc.arg(page_size);

-- name: GatewayListChatSessionFilterUsers :many
SELECT DISTINCT users.id, users.name, users.email, users.image
FROM chat_session_participants AS participants
JOIN chat_sessions AS sessions
  ON sessions.workspace_id = participants.workspace_id
  AND sessions.agent_name = participants.agent_name
  AND sessions.session_id = participants.session_id
JOIN users ON users.id = participants.user_id
WHERE participants.workspace_id = sqlc.arg(workspace_id)
  AND sessions.agent_name = ANY(sqlc.arg(agent_names)::text[])
  AND sessions.parent_session_id IS NULL
  AND (
    sqlc.arg(include_workflow_runs)::boolean
    OR sessions.kind <> 'workflow_run'
  )
ORDER BY users.name, users.email, users.id;

-- name: GatewayListenChatSessions :exec
LISTEN agentz_chat_sessions;

-- name: GatewayGetWorkspaceChatPreference :one
SELECT *
FROM workspace_chat_preferences
WHERE workspace_id = sqlc.arg(workspace_id)
  AND user_id = sqlc.arg(user_id);

-- name: GatewayUpsertWorkspaceChatPreference :one
INSERT INTO workspace_chat_preferences(
  workspace_id,
  user_id,
  agent_name,
  participant_user_ids,
  include_workflow_runs,
  last_agent_name
)
VALUES (
  sqlc.arg(workspace_id),
  sqlc.arg(user_id),
  sqlc.narg(agent_name),
  sqlc.arg(participant_user_ids),
  sqlc.arg(include_workflow_runs),
  sqlc.narg(last_agent_name)
)
ON CONFLICT (workspace_id, user_id) DO UPDATE SET
  agent_name = EXCLUDED.agent_name,
  participant_user_ids = EXCLUDED.participant_user_ids,
  include_workflow_runs = EXCLUDED.include_workflow_runs,
  last_agent_name = EXCLUDED.last_agent_name,
  updated_at = NOW()
RETURNING *;

-- name: GatewayListAgents :many
SELECT tenant_namespace, agent_name, created_at, updated_at
FROM agents
WHERE tenant_namespace = $1
ORDER BY
  CASE WHEN sqlc.arg(sort_by)::text = 'name'
    AND NOT sqlc.arg(sort_desc)::boolean THEN agent_name END ASC,
  CASE WHEN sqlc.arg(sort_by)::text = 'name'
    AND sqlc.arg(sort_desc)::boolean THEN agent_name END DESC,
  CASE WHEN sqlc.arg(sort_by)::text = 'created_at'
    AND NOT sqlc.arg(sort_desc)::boolean THEN created_at END ASC,
  CASE WHEN sqlc.arg(sort_by)::text = 'created_at'
    AND sqlc.arg(sort_desc)::boolean THEN created_at END DESC,
  CASE WHEN sqlc.arg(sort_desc)::boolean THEN agent_name END DESC,
  agent_name ASC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(page_offset);

-- name: GatewayListAgentsByName :many
SELECT tenant_namespace, agent_name, created_at, updated_at
FROM agents
WHERE tenant_namespace = $1
  AND agent_name = ANY($2::text[])
ORDER BY
  CASE WHEN sqlc.arg(sort_by)::text = 'name'
    AND NOT sqlc.arg(sort_desc)::boolean THEN agent_name END ASC,
  CASE WHEN sqlc.arg(sort_by)::text = 'name'
    AND sqlc.arg(sort_desc)::boolean THEN agent_name END DESC,
  CASE WHEN sqlc.arg(sort_by)::text = 'created_at'
    AND NOT sqlc.arg(sort_desc)::boolean THEN created_at END ASC,
  CASE WHEN sqlc.arg(sort_by)::text = 'created_at'
    AND sqlc.arg(sort_desc)::boolean THEN created_at END DESC,
  CASE WHEN sqlc.arg(sort_desc)::boolean THEN agent_name END DESC,
  agent_name ASC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(page_offset);

-- name: GatewayListTraceSessions :many
SELECT
  trace_id,
  session_id,
  agent_name,
  root_span_id,
  started_at,
  ended_at,
  duration_ns,
  span_count,
  error_count,
  tool_count,
  model_count,
  input_tokens,
  output_tokens,
  cached_input_tokens,
  cached_write_tokens,
  cost_usd,
  status_code,
  updated_at
FROM observer_trace_sessions
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND (
    sqlc.narg(session_id)::text IS NULL
    OR session_id = sqlc.narg(session_id)::text
  )
  AND started_at >= sqlc.arg(started_after)
  AND started_at <= sqlc.arg(started_before)
  AND (
    NOT sqlc.arg(cursor_set)::bool
    OR started_at < sqlc.arg(cursor_started_at)
    OR (
      started_at = sqlc.arg(cursor_started_at)
      AND trace_id < sqlc.arg(cursor_trace_id)
    )
    OR (
      started_at = sqlc.arg(cursor_started_at)
      AND trace_id = sqlc.arg(cursor_trace_id)
      AND session_id < sqlc.arg(cursor_session_id)
    )
  )
ORDER BY started_at DESC, trace_id DESC, session_id DESC
LIMIT sqlc.arg(page_size);

-- name: GatewayGetMCPGraph :many
WITH range_rows AS (
  SELECT
    inv.agent_name,
    inv.mcp_connection_name,
    inv.tool_name,
    AVG(CAST(inv.duration_ns AS DOUBLE PRECISION) / 1000000.0) AS avg_latency_ms,
    COUNT(*) FILTER (WHERE NOT inv.failed)::BIGINT AS success_count,
    COUNT(*) FILTER (WHERE inv.failed)::BIGINT AS failed_count
  FROM observer_mcp_tool_invocations inv
  WHERE inv.tenant_namespace = sqlc.arg(tenant_namespace)
    AND inv.agent_name = sqlc.arg(agent_name)
    AND inv.start_time >= sqlc.arg(start_time_after)
    AND inv.start_time < sqlc.arg(start_time_before)
  GROUP BY
    inv.agent_name,
    inv.mcp_connection_name,
    inv.tool_name
)
SELECT
  range_rows.agent_name,
  range_rows.mcp_connection_name,
  range_rows.tool_name,
  range_rows.avg_latency_ms,
  range_rows.success_count,
  range_rows.failed_count,
  observer_mcp_tool_last_called.last_called_at
FROM range_rows
LEFT JOIN observer_mcp_tool_last_called
  ON observer_mcp_tool_last_called.tenant_namespace = sqlc.arg(tenant_namespace)
  AND observer_mcp_tool_last_called.agent_name = range_rows.agent_name
  AND observer_mcp_tool_last_called.mcp_connection_name = range_rows.mcp_connection_name
  AND observer_mcp_tool_last_called.tool_name = range_rows.tool_name
ORDER BY
  range_rows.mcp_connection_name ASC,
  range_rows.tool_name ASC;

-- name: GatewayListSpans :many
SELECT
  id,
  agent_name,
  session_id,
  trace_id,
  span_id,
  parent_span_id,
  start_time,
  end_time,
  duration_ns,
  name,
  span_class,
  operation_name,
  kind,
  status_code,
  error_type,
  error_message,
  model,
  tool_name,
  input_tokens,
  output_tokens,
  cached_input_tokens,
  cached_write_tokens,
  cost_usd,
  llm_finish_reason,
  ingested_at
FROM observer_trace_spans
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND trace_id = sqlc.arg(trace_id)
  AND (
    NOT sqlc.arg(cursor_set)::bool
    OR start_time > sqlc.arg(cursor_start_time)
    OR (
      start_time = sqlc.arg(cursor_start_time)
      AND id > sqlc.arg(cursor_id)
    )
  )
ORDER BY start_time ASC, id ASC
LIMIT sqlc.arg(page_size);

-- name: GatewayGetSpanDetail :one
WITH span_row AS (
  SELECT
    id,
    agent_name,
    session_id,
    trace_id,
    span_id,
    parent_span_id,
    start_time,
    end_time,
    duration_ns,
    name,
    span_class,
    operation_name,
    kind,
    status_code,
    error_type,
    error_message,
    model,
    tool_name,
    input_tokens,
    output_tokens,
    cached_input_tokens,
    cached_write_tokens,
    cost_usd,
    llm_finish_reason,
    resource_attributes,
    span_attributes,
    ingested_at
  FROM observer_trace_spans sp
  WHERE sp.tenant_namespace = sqlc.arg(tenant_namespace)
    AND sp.agent_name = sqlc.arg(agent_name)
    AND sp.trace_id = sqlc.arg(trace_id)
    AND sp.span_id = sqlc.arg(span_id)
  ORDER BY sp.start_time ASC, sp.id ASC
  LIMIT 1
)
SELECT
  s.id,
  s.agent_name,
  s.session_id,
  s.trace_id,
  s.span_id,
  s.parent_span_id,
  s.start_time,
  s.end_time,
  s.duration_ns,
  s.name,
  s.span_class,
  s.operation_name,
  s.kind,
  s.status_code,
  s.error_type,
  s.error_message,
  s.model,
  s.tool_name,
  s.input_tokens,
  s.output_tokens,
  s.cached_input_tokens,
  s.cached_write_tokens,
  s.cost_usd,
  s.llm_finish_reason,
  s.resource_attributes,
  s.span_attributes,
  s.ingested_at,
  COALESCE(p.input_messages, 'null'::jsonb) AS input_messages,
  COALESCE(p.output_messages, 'null'::jsonb) AS output_messages,
  COALESCE(p.tool_arguments, 'null'::jsonb) AS tool_arguments,
  COALESCE(p.tool_result, 'null'::jsonb) AS tool_result
FROM span_row s
LEFT JOIN observer_trace_span_payloads p
  ON p.trace_id = s.trace_id
  AND p.span_id = s.span_id
  AND p.start_time = s.start_time;

-- name: GatewayListProcessEvents :many
SELECT
  id,
  agent_name,
  event_time,
  ingested_at,
  pod_namespace,
  pod_name,
  process,
  parent_process,
  command_invocation,
  action,
  source
FROM observer_process_events
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND event_time >= sqlc.arg(event_time_after)
  AND event_time <= sqlc.arg(event_time_before)
  AND (
    sqlc.arg(action)::text = ''
    OR action = sqlc.arg(action)
  )
  AND (
    NOT sqlc.arg(cursor_set)::bool
    OR event_time < sqlc.arg(cursor_event_time)
    OR (
      event_time = sqlc.arg(cursor_event_time)
      AND id < sqlc.arg(cursor_id)
    )
  )
ORDER BY event_time DESC, id DESC
LIMIT sqlc.arg(page_size);

-- name: GatewayListFileEvents :many
SELECT
  id,
  agent_name,
  event_time,
  ingested_at,
  pod_namespace,
  pod_name,
  file_path_accessed,
  process,
  command_invocation,
  action,
  source
FROM observer_file_events
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND event_time >= sqlc.arg(event_time_after)
  AND event_time <= sqlc.arg(event_time_before)
  AND (
    sqlc.arg(action)::text = ''
    OR action = sqlc.arg(action)
  )
  AND (
    NOT sqlc.arg(cursor_set)::bool
    OR event_time < sqlc.arg(cursor_event_time)
    OR (
      event_time = sqlc.arg(cursor_event_time)
      AND id < sqlc.arg(cursor_id)
    )
  )
ORDER BY event_time DESC, id DESC
LIMIT sqlc.arg(page_size);

-- name: GatewayListProcessEventsAggregated :many
SELECT
  agent_name,
  MAX(event_time)::timestamptz AS last_seen,
  process,
  parent_process,
  command_invocation,
  action,
  source,
  COUNT(*) AS occurrences
FROM observer_process_events
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND event_time >= sqlc.arg(event_time_after)
  AND event_time <= sqlc.arg(event_time_before)
  AND (
    sqlc.arg(action)::text = ''
    OR action = sqlc.arg(action)
  )
GROUP BY agent_name, process, parent_process, command_invocation, action, source
HAVING (
  NOT sqlc.arg(cursor_set)::bool
  OR MAX(event_time) < sqlc.arg(cursor_event_time)
)
ORDER BY MAX(event_time) DESC
LIMIT sqlc.arg(page_size);

-- name: GatewayLockOrganization :one
SELECT id, name, slug
FROM organizations
WHERE id = sqlc.arg(organization_id)
FOR UPDATE;

-- name: GatewayCreateWorkspace :exec
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
    sqlc.arg(name),
    sqlc.arg(slug),
    sqlc.arg(namespace),
    'provisioning',
    1
  )
  RETURNING *
)
INSERT INTO workspace_slug_history(organization_id, workspace_id, slug)
SELECT organization_id, id, slug
FROM created;

-- name: GatewayGetWorkspace :one
SELECT workspaces.*
FROM workspaces
WHERE id = sqlc.arg(id)
  AND organization_id = sqlc.arg(organization_id);

-- name: GatewayLockActiveWorkspace :one
SELECT id
FROM workspaces
WHERE id = sqlc.arg(id)
  AND organization_id = sqlc.arg(organization_id)
  AND deleted_at IS NULL
FOR UPDATE;

-- name: GatewayListWorkspaceInheritedResources :many
SELECT resource, resource_name
FROM workspace_inherited_resources
WHERE workspace_id = sqlc.arg(workspace_id)
  AND organization_id = sqlc.arg(organization_id)
ORDER BY resource, resource_name;

-- name: GatewayInsertWorkspaceInheritedResources :execrows
INSERT INTO workspace_inherited_resources(
  workspace_id,
  organization_id,
  resource,
  resource_name
)
SELECT
  sqlc.arg(workspace_id),
  sqlc.arg(organization_id),
  sqlc.arg(resource),
  selected.resource_name
FROM unnest(sqlc.arg(resource_names)::text[]) AS selected(resource_name)
ON CONFLICT DO NOTHING;

-- name: GatewayDeleteWorkspaceInheritedResources :execrows
DELETE FROM workspace_inherited_resources
WHERE workspace_id = sqlc.arg(workspace_id)
  AND organization_id = sqlc.arg(organization_id)
  AND resource = sqlc.arg(resource);

-- name: GatewayListWorkspacesSelectingOrganizationResource :many
SELECT workspaces.*
FROM workspace_inherited_resources
JOIN workspaces
  ON workspaces.id = workspace_inherited_resources.workspace_id
  AND workspaces.organization_id = workspace_inherited_resources.organization_id
WHERE workspace_inherited_resources.organization_id = sqlc.arg(organization_id)
  AND workspace_inherited_resources.resource = sqlc.arg(resource)
  AND workspace_inherited_resources.resource_name = sqlc.arg(resource_name)
  AND workspaces.deleted_at IS NULL
ORDER BY workspaces.name, workspaces.id;

-- name: GatewayListProvisioningWorkspaces :many
SELECT workspaces.*
FROM workspaces
WHERE state = 'provisioning'
  AND deleted_at IS NULL
ORDER BY created_at, id;

-- name: GatewayListAccessibleWorkspaces :many
WITH actor_roles AS (
  SELECT DISTINCT role_scopes.*
  FROM member_role_assignments
  JOIN role_scopes
    ON role_scopes.role_id = member_role_assignments.role_id
    AND role_scopes.organization_id = member_role_assignments.organization_id
  JOIN members
    ON members.id = member_role_assignments.member_id
    AND members.organization_id = member_role_assignments.organization_id
  WHERE members.user_id = sqlc.arg(user_id)
    AND members.organization_id = sqlc.arg(organization_id)
    AND members.disabled_at IS NULL
)
SELECT
  sqlc.embed(workspaces),
  (
    SELECT COUNT(DISTINCT workspace_admins.member_id)
    FROM role_scopes AS workspace_admin_role
    JOIN member_role_assignments AS workspace_admins
      ON workspace_admins.role_id = workspace_admin_role.role_id
      AND workspace_admins.organization_id = workspace_admin_role.organization_id
    JOIN members AS workspace_admin_members
      ON workspace_admin_members.id = workspace_admins.member_id
      AND workspace_admin_members.organization_id = workspace_admins.organization_id
      AND workspace_admin_members.disabled_at IS NULL
    WHERE workspace_admin_role.organization_id = workspaces.organization_id
      AND workspace_admin_role.workspace_id = workspaces.id
      AND workspace_admin_role.system_role = 'workspace_admin'
      AND workspace_admin_role.immutable
  ) AS workspace_admin_count,
  EXISTS (
    SELECT 1
    FROM actor_roles
    WHERE actor_roles.immutable
      AND (
        (
          actor_roles.system_role = 'superadmin'
          AND actor_roles.workspace_id IS NULL
        ) OR (
          actor_roles.system_role = 'workspace_admin'
          AND actor_roles.workspace_id = workspaces.id
        )
      )
  ) AS can_administer
FROM workspaces
WHERE workspaces.organization_id = sqlc.arg(organization_id)
  AND workspaces.deleted_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM actor_roles
    WHERE (
        actor_roles.immutable
        AND actor_roles.system_role = 'superadmin'
        AND actor_roles.workspace_id IS NULL
      ) OR (
        actor_roles.immutable
        AND actor_roles.system_role = 'workspace_admin'
        AND actor_roles.workspace_id = workspaces.id
      ) OR EXISTS (
        SELECT 1
        FROM permission_grants
        WHERE permission_grants.role_id = actor_roles.role_id
          AND permission_grants.organization_id = actor_roles.organization_id
          AND permission_grants.workspace_id = workspaces.id
      )
  )
  AND (
    NOT sqlc.arg(cursor_set)::bool
    OR workspaces.name > sqlc.arg(cursor_name)
    OR (
      workspaces.name = sqlc.arg(cursor_name)
      AND workspaces.id > sqlc.arg(cursor_id)
    )
  )
ORDER BY workspaces.name, workspaces.id
LIMIT sqlc.arg(page_size);

-- name: GatewayRetryWorkspaceProvisioning :execrows
UPDATE workspaces
SET
  state = 'provisioning',
  provisioning_attempt = provisioning_attempt + 1,
  failure_reason = NULL,
  updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id)
  AND organization_id = sqlc.arg(organization_id)
  AND state = 'failed'
  AND deleted_at IS NULL;

-- name: GatewayTransitionWorkspaceProvisioning :execrows
UPDATE workspaces
SET
  state = sqlc.arg(state),
  failure_reason = CASE
    WHEN sqlc.arg(state)::workspace_state = 'failed'
    THEN sqlc.narg(failure_reason)
    ELSE NULL
  END,
  updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id)
  AND organization_id = sqlc.arg(organization_id)
  AND provisioning_attempt = sqlc.arg(provisioning_attempt)
  AND (
    state = 'provisioning'
    OR (state = 'ready' AND sqlc.arg(state)::workspace_state = 'failed')
  )
  AND (
    sqlc.arg(state)::workspace_state = 'ready'
    OR (
      sqlc.arg(state)::workspace_state = 'failed'
      AND NULLIF(BTRIM(sqlc.narg(failure_reason)::text), '') IS NOT NULL
    )
  )
  AND deleted_at IS NULL;

-- name: GatewayResolveWorkspaceSlug :one
WITH actor_roles AS (
  SELECT DISTINCT role_scopes.*
  FROM member_role_assignments
  JOIN role_scopes
    ON role_scopes.role_id = member_role_assignments.role_id
    AND role_scopes.organization_id = member_role_assignments.organization_id
  JOIN members
    ON members.id = member_role_assignments.member_id
    AND members.organization_id = member_role_assignments.organization_id
  WHERE members.user_id = sqlc.arg(user_id)
    AND members.organization_id = sqlc.arg(organization_id)
    AND members.disabled_at IS NULL
)
SELECT
  sqlc.embed(workspaces)
FROM workspace_slug_history
JOIN workspaces
  ON workspaces.id = workspace_slug_history.workspace_id
  AND workspaces.organization_id = workspace_slug_history.organization_id
WHERE workspace_slug_history.organization_id = sqlc.arg(organization_id)
  AND workspace_slug_history.slug = sqlc.arg(slug)
  AND workspaces.deleted_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM actor_roles
    WHERE (
        (
          actor_roles.immutable
          AND actor_roles.system_role = 'superadmin'
          AND actor_roles.workspace_id IS NULL
        ) OR (
          actor_roles.immutable
          AND actor_roles.system_role = 'workspace_admin'
          AND actor_roles.workspace_id = workspaces.id
        ) OR EXISTS (
          SELECT 1
          FROM permission_grants
          WHERE permission_grants.role_id = actor_roles.role_id
            AND permission_grants.organization_id = actor_roles.organization_id
            AND permission_grants.workspace_id = workspaces.id
        )
      )
  );

-- name: GatewayCreateWorkspaceAdminRole :one
WITH organization_role AS (
  INSERT INTO organization_roles(id, organization_id, role, permission)
  SELECT
    'workspace_admin:' || workspaces.id,
    workspaces.organization_id,
    'workspace_admin:' || workspaces.id,
    '{}'
  FROM workspaces
  WHERE workspaces.id = sqlc.arg(workspace_id)
    AND workspaces.organization_id = sqlc.arg(organization_id)
    AND workspaces.deleted_at IS NULL
  RETURNING id, organization_id
)
INSERT INTO role_scopes(
  role_id,
  organization_id,
  workspace_id,
  display_name,
  system_role,
  immutable
)
SELECT
  organization_role.id,
  organization_role.organization_id,
  workspaces.id,
  'Workspace Admin',
  'workspace_admin',
  TRUE
FROM organization_role
JOIN workspaces
  ON workspaces.id = sqlc.arg(workspace_id)
  AND workspaces.organization_id = organization_role.organization_id
  AND workspaces.deleted_at IS NULL
RETURNING
  role_id,
  organization_id,
  workspace_id,
  display_name,
  system_role,
  immutable,
  created_at,
  updated_at;

-- name: GatewayListUsersByID :many
SELECT id, name, email, image
FROM users
WHERE id = ANY(sqlc.arg(user_ids)::text[]);

-- name: GatewayListWorkspaceAdminCandidates :many
SELECT
  members.id AS member_id,
  members.user_id,
  users.name,
  users.email,
  users.image
FROM members
JOIN users ON users.id = members.user_id
WHERE members.organization_id = sqlc.arg(organization_id)
  AND members.disabled_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM members AS actor
    JOIN member_role_assignments AS actor_roles
      ON actor_roles.member_id = actor.id
      AND actor_roles.organization_id = actor.organization_id
    JOIN role_scopes AS actor_role_scopes
      ON actor_role_scopes.role_id = actor_roles.role_id
      AND actor_role_scopes.organization_id = actor_roles.organization_id
    WHERE actor.user_id = sqlc.arg(actor_user_id)
      AND actor.organization_id = members.organization_id
      AND actor.disabled_at IS NULL
      AND actor_role_scopes.workspace_id IS NULL
      AND actor_role_scopes.system_role = 'superadmin'
      AND actor_role_scopes.immutable
  )
  AND NOT EXISTS (
    SELECT 1
    FROM member_role_assignments
    JOIN role_scopes
      ON role_scopes.role_id = member_role_assignments.role_id
      AND role_scopes.organization_id = member_role_assignments.organization_id
    WHERE member_role_assignments.member_id = members.id
      AND member_role_assignments.organization_id = members.organization_id
      AND role_scopes.workspace_id IS NULL
      AND role_scopes.system_role = 'superadmin'
      AND role_scopes.immutable
  )
ORDER BY users.name, users.email, members.id;

-- name: GatewayAssignWorkspaceAdmins :execrows
INSERT INTO member_roles(member_id, role_id, organization_id)
SELECT members.id, role_scopes.role_id, members.organization_id
FROM members
JOIN role_scopes
  ON role_scopes.role_id = sqlc.arg(role_id)
  AND role_scopes.organization_id = members.organization_id
WHERE members.id = ANY(sqlc.arg(member_ids)::text[])
  AND members.organization_id = sqlc.arg(organization_id)
  AND members.disabled_at IS NULL
  AND role_scopes.workspace_id = sqlc.arg(workspace_id)
  AND role_scopes.system_role = 'workspace_admin'
  AND role_scopes.immutable
  AND NOT EXISTS (
    SELECT 1
    FROM member_role_assignments AS superadmin_roles
    JOIN role_scopes AS superadmin_role_scopes
      ON superadmin_role_scopes.role_id = superadmin_roles.role_id
      AND superadmin_role_scopes.organization_id = superadmin_roles.organization_id
    WHERE superadmin_roles.member_id = members.id
      AND superadmin_roles.organization_id = members.organization_id
      AND superadmin_role_scopes.workspace_id IS NULL
      AND superadmin_role_scopes.system_role = 'superadmin'
      AND superadmin_role_scopes.immutable
  )
ON CONFLICT DO NOTHING;

-- name: GatewayProjectMemberRoleTransports :execrows
UPDATE members
SET role = COALESCE((
  SELECT string_agg(
    DISTINCT organization_roles.role,
    ',' ORDER BY organization_roles.role
  )
  FROM member_role_assignments
  JOIN organization_roles
    ON organization_roles.id = member_role_assignments.role_id
    AND organization_roles.organization_id = member_role_assignments.organization_id
  WHERE member_role_assignments.member_id = members.id
    AND member_role_assignments.organization_id = members.organization_id
), 'member')
WHERE members.id = ANY(sqlc.arg(member_ids)::text[])
  AND members.organization_id = sqlc.arg(organization_id);

-- name: GatewayGetAPIKeyScopeByKey :one
SELECT
  api_key_scopes.api_key_id,
  api_key_scopes.organization_id,
  api_key_scopes.workspace_id,
  api_key_scopes.creator_user_id,
  api_key_scopes.revoked_at,
  api_key_scopes.revoked_reason,
  api_key_scopes.created_at
FROM api_key_scopes
JOIN apikeys ON apikeys.id = api_key_scopes.api_key_id
  AND apikeys.reference_id = api_key_scopes.organization_id
JOIN workspaces ON workspaces.id = api_key_scopes.workspace_id
  AND workspaces.organization_id = api_key_scopes.organization_id
  AND workspaces.deleted_at IS NULL
WHERE api_key_scopes.api_key_id = sqlc.arg(api_key_id)
  AND api_key_scopes.organization_id = sqlc.arg(organization_id);

-- name: GatewayListAPIKeyTargets :many
SELECT target_type, agent_name, workflow_name
FROM api_key_targets
WHERE api_key_id = sqlc.arg(api_key_id)
ORDER BY target_type, agent_name, workflow_name;

-- name: GatewayRevokeScopedAPIKey :execrows
WITH revoked AS (
  UPDATE api_key_scopes
  SET revoked_at = sqlc.arg(revoked_at),
    revoked_reason = sqlc.arg(revoked_reason)
  WHERE api_key_scopes.api_key_id = sqlc.arg(api_key_id)
    AND api_key_scopes.organization_id = sqlc.arg(organization_id)
    AND api_key_scopes.workspace_id = sqlc.arg(workspace_id)
    AND api_key_scopes.revoked_at IS NULL
  RETURNING
    api_key_scopes.api_key_id,
    api_key_scopes.organization_id,
    api_key_scopes.workspace_id
), disabled AS (
  UPDATE apikeys
  SET enabled = false,
    updated_at = sqlc.arg(updated_at)
  FROM revoked
  WHERE apikeys.id = revoked.api_key_id
    AND apikeys.reference_id = revoked.organization_id
  RETURNING apikeys.id
)
INSERT INTO event_trail_events(
  id,
  organization_id,
  workspace_id,
  actor_type,
  target_type,
  target_id,
  category,
  action,
  result,
  after
)
SELECT
  sqlc.arg(event_trail_id),
  revoked.organization_id,
  revoked.workspace_id,
  'system',
  'api_key',
  revoked.api_key_id,
  'api_key',
  'api_key.revoke',
  'succeeded',
  jsonb_build_array(jsonb_build_object('field', 'state', 'value', 'revoked'))
FROM revoked
JOIN disabled ON disabled.id = revoked.api_key_id;

-- name: GatewayCreateAgentOwner :one
INSERT INTO agent_owners(
  organization_id,
  workspace_id,
  agent_name,
  creator_user_id,
  owner_user_id
)
SELECT
  workspaces.organization_id,
  workspaces.id,
  sqlc.arg(agent_name),
  creator.user_id,
  owner_member.user_id
FROM workspaces
JOIN members AS creator
  ON creator.organization_id = workspaces.organization_id
  AND creator.user_id = sqlc.arg(creator_user_id)
  AND creator.disabled_at IS NULL
JOIN members AS owner_member
  ON owner_member.organization_id = workspaces.organization_id
  AND owner_member.user_id = sqlc.arg(owner_user_id)
  AND owner_member.disabled_at IS NULL
WHERE workspaces.id = sqlc.arg(workspace_id)
  AND workspaces.organization_id = sqlc.arg(organization_id)
  AND workspaces.deleted_at IS NULL
RETURNING
  agent_owners.organization_id,
  agent_owners.workspace_id,
  agent_owners.agent_name,
  agent_owners.creator_user_id,
  agent_owners.owner_user_id,
  agent_owners.created_at,
  agent_owners.updated_at;

-- name: GatewayGetAgentOwner :one
SELECT
  organization_id,
  workspace_id,
  agent_name,
  creator_user_id,
  owner_user_id,
  created_at,
  updated_at
FROM agent_owners
WHERE organization_id = sqlc.arg(organization_id)
  AND workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name);

-- name: GatewayLockAgentOwner :one
SELECT
  organization_id,
  workspace_id,
  agent_name,
  creator_user_id,
  owner_user_id,
  created_at,
  updated_at
FROM agent_owners
WHERE organization_id = sqlc.arg(organization_id)
  AND workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name)
FOR UPDATE;

-- name: GatewayDeleteAgentOwner :execrows
DELETE FROM agent_owners
WHERE organization_id = sqlc.arg(organization_id)
  AND workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name);

-- name: GatewayListAgentRelationships :many
SELECT
  agent_owners.agent_name,
  agent_owners.owner_user_id,
  agent_share_grants.capability
FROM agent_owners
LEFT JOIN agent_shares
  ON agent_shares.organization_id = agent_owners.organization_id
  AND agent_shares.workspace_id = agent_owners.workspace_id
  AND agent_shares.agent_name = agent_owners.agent_name
  AND (
    agent_shares.target_user_id = sqlc.arg(user_id)
    OR EXISTS (
      SELECT 1
      FROM team_members
      JOIN teams
        ON teams.id = team_members.team_id
        AND teams.organization_id = agent_shares.organization_id
      WHERE team_members.team_id = agent_shares.target_team_id
        AND team_members.user_id = sqlc.arg(user_id)
    )
  )
LEFT JOIN agent_share_grants ON agent_share_grants.share_id = agent_shares.id
WHERE agent_owners.organization_id = sqlc.arg(organization_id)
  AND agent_owners.workspace_id = sqlc.arg(workspace_id)
  AND (
    sqlc.narg(agent_name)::text IS NULL
    OR agent_owners.agent_name = sqlc.narg(agent_name)
  )
ORDER BY agent_owners.agent_name, agent_share_grants.capability;

-- name: GatewayTransferAgentOwner :one
UPDATE agent_owners
SET
  owner_user_id = members.user_id,
  updated_at = sqlc.arg(updated_at)
FROM members, workspaces
WHERE workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name)
  AND agent_owners.organization_id = sqlc.arg(organization_id)
  AND workspaces.id = agent_owners.workspace_id
  AND workspaces.organization_id = agent_owners.organization_id
  AND workspaces.deleted_at IS NULL
  AND members.organization_id = agent_owners.organization_id
  AND members.user_id = sqlc.arg(owner_user_id)
  AND members.disabled_at IS NULL
RETURNING
  agent_owners.organization_id,
  agent_owners.workspace_id,
  agent_owners.agent_name,
  agent_owners.creator_user_id,
  agent_owners.owner_user_id,
  agent_owners.created_at,
  agent_owners.updated_at;

-- name: GatewayCreateAgentShare :one
INSERT INTO agent_shares(
  id,
  organization_id,
  workspace_id,
  agent_name,
  target_user_id,
  target_team_id,
  created_by
)
SELECT
  sqlc.arg(id),
  agent_owners.organization_id,
  agent_owners.workspace_id,
  agent_owners.agent_name,
  target_member.user_id,
  target_team.id,
  creator.user_id
FROM agent_owners
JOIN workspaces
  ON workspaces.id = agent_owners.workspace_id
  AND workspaces.organization_id = agent_owners.organization_id
  AND workspaces.deleted_at IS NULL
JOIN members AS creator
  ON creator.organization_id = agent_owners.organization_id
  AND creator.user_id = sqlc.arg(created_by)
  AND creator.disabled_at IS NULL
LEFT JOIN members AS target_member
  ON target_member.organization_id = agent_owners.organization_id
  AND target_member.user_id = sqlc.narg(target_user_id)
  AND target_member.disabled_at IS NULL
LEFT JOIN teams AS target_team
  ON target_team.organization_id = agent_owners.organization_id
  AND target_team.id = sqlc.narg(target_team_id)
WHERE agent_owners.organization_id = sqlc.arg(organization_id)
  AND agent_owners.workspace_id = sqlc.arg(workspace_id)
  AND agent_owners.agent_name = sqlc.arg(agent_name)
  AND num_nonnulls(target_member.user_id, target_team.id) = 1
RETURNING
  id,
  organization_id,
  workspace_id,
  agent_name,
  target_user_id,
  target_team_id,
  created_by,
  created_at;

-- name: GatewayListAgentShares :many
SELECT
  id,
  organization_id,
  workspace_id,
  agent_name,
  target_user_id,
  target_team_id,
  created_by,
  created_at
FROM agent_shares
WHERE organization_id = sqlc.arg(organization_id)
  AND workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name)
  AND (sqlc.arg(manage_all)::bool OR created_by = sqlc.arg(user_id))
  AND (
    NOT sqlc.arg(cursor_set)::bool
    OR created_at < sqlc.arg(cursor_created_at)
    OR (
      created_at = sqlc.arg(cursor_created_at)
      AND id < sqlc.arg(cursor_id)
    )
  )
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_size);

-- name: GatewayGetAgentShare :one
SELECT
  id,
  organization_id,
  workspace_id,
  agent_name,
  target_user_id,
  target_team_id,
  created_by,
  created_at
FROM agent_shares
WHERE organization_id = sqlc.arg(organization_id)
  AND workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name)
  AND id = sqlc.arg(id);

-- name: GatewayLockAgentShares :many
SELECT
  id,
  organization_id,
  workspace_id,
  agent_name,
  target_user_id,
  target_team_id,
  created_by,
  created_at
FROM agent_shares
WHERE organization_id = sqlc.arg(organization_id)
  AND workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name)
ORDER BY target_user_id NULLS LAST, target_team_id NULLS LAST, id
FOR UPDATE;

-- name: GatewayTeamExists :one
SELECT EXISTS(
  SELECT 1
  FROM teams
  WHERE id = sqlc.arg(team_id)
    AND organization_id = sqlc.arg(organization_id)
);

-- name: GatewayListTeamAgentShareCapabilities :many
SELECT DISTINCT permission_grants.action
FROM teams
JOIN team_roles
  ON team_roles.team_id = teams.id
  AND team_roles.organization_id = teams.organization_id
JOIN role_scopes
  ON role_scopes.role_id = team_roles.role_id
  AND role_scopes.organization_id = team_roles.organization_id
JOIN permission_grants
  ON permission_grants.role_id = role_scopes.role_id
  AND permission_grants.organization_id = role_scopes.organization_id
  AND (
    role_scopes.workspace_id IS NULL
    OR permission_grants.workspace_id IS NOT DISTINCT FROM role_scopes.workspace_id
  )
WHERE teams.id = sqlc.arg(team_id)
  AND teams.organization_id = sqlc.arg(organization_id)
  AND permission_grants.workspace_id = sqlc.arg(workspace_id)
  AND permission_grants.resource = 'agent'
  AND permission_grants.action IN (
    'share_non_authored',
    'use_shared',
    'read_shared_secret',
    'write_shared_secret',
    'delete_shared_secret'
  )
ORDER BY permission_grants.action;

-- name: GatewayListAgentAccessTargets :many
WITH assigned_roles AS (
  SELECT DISTINCT members.user_id, member_role_assignments.role_id
  FROM member_role_assignments
  JOIN members
    ON members.id = member_role_assignments.member_id
    AND members.organization_id = member_role_assignments.organization_id
  WHERE members.organization_id = sqlc.arg(organization_id)
    AND members.disabled_at IS NULL
), user_targets AS (
  SELECT DISTINCT
    'user'::text AS kind,
    users.id,
    users.name AS label,
    users.email,
    users.image,
    EXISTS (
      SELECT 1
      FROM member_role_assignments AS administrator_roles
      JOIN role_scopes AS administrator_scopes
        ON administrator_scopes.role_id = administrator_roles.role_id
        AND administrator_scopes.organization_id = administrator_roles.organization_id
      WHERE administrator_roles.member_id = members.id
        AND administrator_roles.organization_id = members.organization_id
        AND administrator_scopes.immutable
        AND (
          (
            administrator_scopes.system_role = 'superadmin'
            AND administrator_scopes.workspace_id IS NULL
          ) OR (
            administrator_scopes.system_role = 'workspace_admin'
            AND administrator_scopes.workspace_id = sqlc.arg(workspace_id)
          )
        )
    ) AS administrator,
    permission_grants.action
  FROM members
  JOIN users ON users.id = members.user_id
  LEFT JOIN assigned_roles ON assigned_roles.user_id = members.user_id
  LEFT JOIN role_scopes
    ON role_scopes.role_id = assigned_roles.role_id
    AND role_scopes.organization_id = members.organization_id
  LEFT JOIN permission_grants
    ON permission_grants.role_id = role_scopes.role_id
    AND permission_grants.organization_id = role_scopes.organization_id
    AND permission_grants.workspace_id = sqlc.arg(workspace_id)
    AND permission_grants.resource = 'agent'
    AND (
      role_scopes.workspace_id IS NULL
      OR permission_grants.workspace_id IS NOT DISTINCT FROM role_scopes.workspace_id
    )
  WHERE members.organization_id = sqlc.arg(organization_id)
    AND members.disabled_at IS NULL
), team_targets AS (
  SELECT DISTINCT
    'team'::text AS kind,
    teams.id,
    teams.name AS label,
    ''::text AS email,
    NULL::text AS image,
    EXISTS (
      SELECT 1
      FROM team_roles AS administrator_roles
      JOIN role_scopes AS administrator_scopes
        ON administrator_scopes.role_id = administrator_roles.role_id
        AND administrator_scopes.organization_id = administrator_roles.organization_id
      WHERE administrator_roles.team_id = teams.id
        AND administrator_roles.organization_id = teams.organization_id
        AND administrator_scopes.immutable
        AND (
          (
            administrator_scopes.system_role = 'superadmin'
            AND administrator_scopes.workspace_id IS NULL
          ) OR (
            administrator_scopes.system_role = 'workspace_admin'
            AND administrator_scopes.workspace_id = sqlc.arg(workspace_id)
          )
        )
    ) AS administrator,
    permission_grants.action
  FROM teams
  LEFT JOIN team_roles
    ON team_roles.team_id = teams.id
    AND team_roles.organization_id = teams.organization_id
  LEFT JOIN role_scopes
    ON role_scopes.role_id = team_roles.role_id
    AND role_scopes.organization_id = team_roles.organization_id
  LEFT JOIN permission_grants
    ON permission_grants.role_id = role_scopes.role_id
    AND permission_grants.organization_id = role_scopes.organization_id
    AND permission_grants.workspace_id = sqlc.arg(workspace_id)
    AND permission_grants.resource = 'agent'
    AND (
      role_scopes.workspace_id IS NULL
      OR permission_grants.workspace_id IS NOT DISTINCT FROM role_scopes.workspace_id
    )
  WHERE teams.organization_id = sqlc.arg(organization_id)
)
SELECT * FROM user_targets
UNION ALL
SELECT * FROM team_targets
ORDER BY kind, label, email, id, action;

-- name: GatewayLockTeam :one
SELECT id
FROM teams
WHERE id = sqlc.arg(team_id)
  AND organization_id = sqlc.arg(organization_id)
FOR SHARE;

-- name: GatewayDeleteAgentShare :execrows
DELETE FROM agent_shares
WHERE id = sqlc.arg(id)
  AND organization_id = sqlc.arg(organization_id)
  AND workspace_id = sqlc.arg(workspace_id);

-- name: GatewayAddAgentShareGrant :execrows
INSERT INTO agent_share_grants(share_id, capability)
SELECT agent_shares.id, sqlc.arg(capability)
FROM agent_shares
JOIN workspaces
  ON workspaces.id = agent_shares.workspace_id
  AND workspaces.organization_id = agent_shares.organization_id
  AND workspaces.deleted_at IS NULL
WHERE agent_shares.id = sqlc.arg(share_id)
  AND agent_shares.organization_id = sqlc.arg(organization_id)
  AND agent_shares.workspace_id = sqlc.arg(workspace_id)
ON CONFLICT DO NOTHING;

-- name: GatewayListAgentShareGrants :many
SELECT agent_share_grants.share_id, agent_share_grants.capability
FROM agent_share_grants
JOIN agent_shares ON agent_shares.id = agent_share_grants.share_id
WHERE agent_share_grants.share_id = sqlc.arg(share_id)
  AND agent_shares.organization_id = sqlc.arg(organization_id)
  AND agent_shares.workspace_id = sqlc.arg(workspace_id)
ORDER BY agent_share_grants.capability;

-- name: GatewayClaimCleanupJob :one
WITH next_job AS (
  SELECT id
  FROM cleanup_jobs
  WHERE (
      state IN ('pending', 'retrying')
      AND next_attempt_at <= sqlc.arg(now_at)
    ) OR (
      state = 'running'
      AND lease_expires_at <= sqlc.arg(now_at)
    )
  ORDER BY next_attempt_at, created_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE cleanup_jobs
SET
  state = 'running',
  attempts = attempts + 1,
  lease_token = sqlc.arg(lease_token),
  lease_expires_at = sqlc.arg(lease_expires_at),
  updated_at = sqlc.arg(now_at)
FROM next_job
WHERE cleanup_jobs.id = next_job.id
RETURNING
  cleanup_jobs.id,
  cleanup_jobs.organization_id,
  cleanup_jobs.workspace_id,
  cleanup_jobs.operation,
  cleanup_jobs.target_type,
  cleanup_jobs.target_id,
  cleanup_jobs.state,
  cleanup_jobs.payload,
  cleanup_jobs.attempts,
  cleanup_jobs.next_attempt_at,
  cleanup_jobs.lease_token,
  cleanup_jobs.lease_expires_at,
  cleanup_jobs.last_error,
  cleanup_jobs.created_at,
  cleanup_jobs.updated_at,
  cleanup_jobs.completed_at;

-- name: GatewayCompleteCleanupJob :execrows
UPDATE cleanup_jobs
SET
  state = 'succeeded',
  lease_token = NULL,
  lease_expires_at = NULL,
  last_error = NULL,
  updated_at = sqlc.arg(completed_at),
  completed_at = sqlc.arg(completed_at)
WHERE id = sqlc.arg(id)
  AND state = 'running'
  AND lease_token = sqlc.arg(lease_token);

-- name: GatewayRetryCleanupJob :execrows
UPDATE cleanup_jobs
SET
  state = 'retrying',
  next_attempt_at = sqlc.arg(next_attempt_at),
  lease_token = NULL,
  lease_expires_at = NULL,
  last_error = sqlc.arg(last_error),
  updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id)
  AND state = 'running'
  AND lease_token = sqlc.arg(lease_token);

-- name: GatewayFailCleanupJob :execrows
UPDATE cleanup_jobs
SET
  state = 'failed',
  lease_token = NULL,
  lease_expires_at = NULL,
  last_error = sqlc.arg(last_error),
  updated_at = sqlc.arg(failed_at)
WHERE id = sqlc.arg(id)
  AND state = 'running'
  AND lease_token = sqlc.arg(lease_token);

-- name: GatewayIsActiveSuperadmin :one
SELECT EXISTS(
  SELECT 1
  FROM member_role_assignments
  JOIN members
    ON members.id = member_role_assignments.member_id
    AND members.organization_id = member_role_assignments.organization_id
  JOIN role_scopes
    ON role_scopes.role_id = member_role_assignments.role_id
    AND role_scopes.organization_id = member_role_assignments.organization_id
  WHERE members.user_id = sqlc.arg(user_id)
    AND members.organization_id = sqlc.arg(organization_id)
    AND members.disabled_at IS NULL
    AND role_scopes.system_role = 'superadmin'
    AND role_scopes.immutable
);

-- name: GatewayResolvePermissions :many
WITH actor AS (
  SELECT members.id, members.user_id, members.organization_id
  FROM members
  WHERE members.user_id = sqlc.arg(user_id)
    AND members.organization_id = sqlc.arg(organization_id)
    AND members.disabled_at IS NULL
), assigned_role_ids AS (
  SELECT DISTINCT
    member_role_assignments.role_id,
    member_role_assignments.organization_id
  FROM actor
  JOIN member_role_assignments
    ON member_role_assignments.member_id = actor.id
    AND member_role_assignments.organization_id = actor.organization_id
), assigned_roles AS (
  SELECT role_scopes.*
  FROM assigned_role_ids
  JOIN role_scopes
    ON role_scopes.role_id = assigned_role_ids.role_id
    AND role_scopes.organization_id = assigned_role_ids.organization_id
), authority AS (
  SELECT
    EXISTS(SELECT 1 FROM actor) AS active,
    EXISTS(
      SELECT 1
      FROM assigned_roles
      WHERE system_role = 'superadmin'
        AND workspace_id IS NULL
        AND immutable
    ) AS superadmin
), access AS (
  SELECT DISTINCT
    permission_grants.workspace_id,
    permission_grants.resource,
    permission_grants.action,
    FALSE AS workspace_admin
  FROM assigned_roles
  JOIN permission_grants
    ON permission_grants.role_id = assigned_roles.role_id
    AND permission_grants.organization_id = assigned_roles.organization_id
    AND (
      assigned_roles.workspace_id IS NULL
      OR permission_grants.workspace_id IS NOT DISTINCT FROM assigned_roles.workspace_id
    )
  UNION ALL
  SELECT DISTINCT
    assigned_roles.workspace_id,
    NULL::permission_resource,
    NULL::permission_action,
    TRUE
  FROM assigned_roles
  WHERE assigned_roles.system_role = 'workspace_admin'
    AND assigned_roles.workspace_id IS NOT NULL
    AND assigned_roles.immutable
)
SELECT
  authority.active,
  authority.superadmin,
  access.workspace_id,
  access.resource,
  access.action,
  COALESCE(access.workspace_admin, FALSE) AS workspace_admin
FROM authority
LEFT JOIN access ON TRUE
ORDER BY
  access.workspace_id NULLS FIRST,
  access.resource,
  access.action;

-- name: GatewayIsActiveOrganizationMember :one
SELECT EXISTS(
  SELECT 1
  FROM members
  WHERE user_id = sqlc.arg(user_id)
    AND organization_id = sqlc.arg(organization_id)
    AND disabled_at IS NULL
);

-- name: GatewayLockActiveOrganizationMember :one
SELECT id
FROM members
WHERE user_id = sqlc.arg(user_id)
  AND organization_id = sqlc.arg(organization_id)
  AND disabled_at IS NULL
FOR UPDATE;

-- name: GatewayCreateEventTrailEvent :one
INSERT INTO event_trail_events(
  id,
  organization_id,
  workspace_id,
  actor_type,
  actor_id,
  target_type,
  target_id,
  category,
  action,
  result,
  before,
  after
)
VALUES (
  sqlc.arg(id),
  sqlc.arg(organization_id),
  sqlc.narg(workspace_id),
  sqlc.arg(actor_type),
  sqlc.narg(actor_id),
  sqlc.arg(target_type),
  sqlc.arg(target_id),
  sqlc.arg(category),
  sqlc.arg(action),
  sqlc.arg(result),
  sqlc.narg(before),
  sqlc.narg(after)
)
RETURNING
  id,
  organization_id,
  workspace_id,
  actor_type,
  actor_id,
  target_type,
  target_id,
  category,
  action,
  result,
  before,
  after,
  created_at;

-- name: GatewayListEventTrailEvents :many
SELECT
  event_trail_events.id,
  event_trail_events.organization_id,
  event_trail_events.workspace_id,
  event_trail_events.actor_type,
  event_trail_events.actor_id,
  COALESCE(users.name, apikeys.name, event_trail_events.actor_id, 'System') AS actor_name,
  users.email AS actor_email,
  event_trail_events.target_type,
  event_trail_events.target_id,
  COALESCE(
    CASE event_trail_events.target_type
      WHEN 'organization' THEN organizations.name
      WHEN 'workspace' THEN target_workspaces.name
      WHEN 'organization_membership' THEN target_users.name
      WHEN 'team' THEN target_teams.name
    END,
    event_trail_events.target_id
  ) AS target_name,
  (COALESCE(
    (CASE event_trail_events.target_type
      WHEN 'organization' THEN organizations.slug
      WHEN 'workspace' THEN target_workspaces.slug
    END)::text,
    ''
  ))::text AS target_slug,
  event_trail_events.category,
  event_trail_events.action,
  event_trail_events.result,
  event_trail_events.before,
  event_trail_events.after,
  event_trail_events.created_at,
  workspaces.name AS workspace_name,
  workspaces.slug AS workspace_slug
FROM event_trail_events
JOIN organizations
  ON organizations.id = event_trail_events.organization_id
LEFT JOIN users
  ON event_trail_events.actor_type = 'user'
  AND users.id = event_trail_events.actor_id
LEFT JOIN apikeys
  ON event_trail_events.actor_type = 'api_key'
  AND apikeys.id = event_trail_events.actor_id
LEFT JOIN workspaces
  ON workspaces.id = event_trail_events.workspace_id
  AND workspaces.organization_id = event_trail_events.organization_id
LEFT JOIN workspaces AS target_workspaces
  ON event_trail_events.target_type = 'workspace'
  AND target_workspaces.id = event_trail_events.target_id
  AND target_workspaces.organization_id = event_trail_events.organization_id
LEFT JOIN members AS target_members
  ON event_trail_events.target_type = 'organization_membership'
  AND target_members.id = event_trail_events.target_id
  AND target_members.organization_id = event_trail_events.organization_id
LEFT JOIN users AS target_users
  ON target_users.id = target_members.user_id
LEFT JOIN teams AS target_teams
  ON event_trail_events.target_type = 'team'
  AND target_teams.id = event_trail_events.target_id
  AND target_teams.organization_id = event_trail_events.organization_id
WHERE event_trail_events.organization_id = sqlc.arg(organization_id)
  AND event_trail_events.created_at >= sqlc.arg(retained_after)
  AND (
    sqlc.narg(event_id)::text IS NULL
    OR event_trail_events.id = sqlc.narg(event_id)::text
  )
  AND (
    COALESCE(cardinality(sqlc.arg(actor_types)::text[]), 0) = 0
    OR event_trail_events.actor_type = ANY(sqlc.arg(actor_types)::text[]::event_trail_actor[])
  )
  AND (
    COALESCE(cardinality(sqlc.arg(actor_ids)::text[]), 0) = 0
    OR event_trail_events.actor_id = ANY(sqlc.arg(actor_ids)::text[])
  )
  AND (
    COALESCE(cardinality(sqlc.arg(categories)::text[]), 0) = 0
    OR event_trail_events.category = ANY(sqlc.arg(categories)::text[])
  )
  AND (
    sqlc.narg(scope_workspace_id)::text IS NULL
    OR event_trail_events.workspace_id = sqlc.narg(scope_workspace_id)::text
  )
  AND (
    COALESCE(cardinality(sqlc.arg(workspace_ids)::text[]), 0) = 0
    OR event_trail_events.workspace_id = ANY(sqlc.arg(workspace_ids)::text[])
  )
  AND (
    COALESCE(cardinality(sqlc.arg(target_types)::text[]), 0) = 0
    OR event_trail_events.target_type = ANY(sqlc.arg(target_types)::text[]::event_trail_target[])
  )
  AND (
    COALESCE(cardinality(sqlc.arg(results)::text[]), 0) = 0
    OR event_trail_events.result = ANY(sqlc.arg(results)::text[]::event_trail_result[])
  )
  AND (
    sqlc.narg(created_after)::timestamptz IS NULL
    OR event_trail_events.created_at >= sqlc.narg(created_after)::timestamptz
  )
  AND (
    sqlc.narg(created_before)::timestamptz IS NULL
    OR event_trail_events.created_at <= sqlc.narg(created_before)::timestamptz
  )
  AND (
    NOT sqlc.arg(cursor_set)::boolean
    OR event_trail_events.created_at < sqlc.arg(cursor_created_at)::timestamptz
    OR (
      event_trail_events.created_at = sqlc.arg(cursor_created_at)::timestamptz
      AND event_trail_events.id < sqlc.arg(cursor_id)::text
    )
  )
ORDER BY event_trail_events.created_at DESC, event_trail_events.id DESC
LIMIT sqlc.arg(page_size);

-- name: GatewayListEventTrailActors :many
SELECT
  event_trail_events.actor_type,
  event_trail_events.actor_id,
  COALESCE(users.name, apikeys.name, event_trail_events.actor_id, 'System') AS actor_name,
  users.email AS actor_email
FROM event_trail_events
LEFT JOIN users
  ON event_trail_events.actor_type = 'user'
  AND users.id = event_trail_events.actor_id
LEFT JOIN apikeys
  ON event_trail_events.actor_type = 'api_key'
  AND apikeys.id = event_trail_events.actor_id
WHERE event_trail_events.organization_id = sqlc.arg(organization_id)
  AND event_trail_events.created_at >= sqlc.arg(retained_after)
  AND (
    sqlc.narg(workspace_id)::text IS NULL
    OR event_trail_events.workspace_id = sqlc.narg(workspace_id)::text
  )
GROUP BY
  event_trail_events.actor_type,
  event_trail_events.actor_id,
  users.name,
  users.email,
  apikeys.name
ORDER BY COALESCE(users.name, apikeys.name, event_trail_events.actor_id, 'System'), event_trail_events.actor_type;

-- name: GatewayListEventTrailCategories :many
SELECT DISTINCT category
FROM event_trail_events
WHERE event_trail_events.organization_id = sqlc.arg(organization_id)
  AND event_trail_events.created_at >= sqlc.arg(retained_after)
  AND (
    sqlc.narg(workspace_id)::text IS NULL
    OR event_trail_events.workspace_id = sqlc.narg(workspace_id)::text
  )
ORDER BY category;

-- name: GatewayListEventTrailTargetTypes :many
SELECT DISTINCT target_type
FROM event_trail_events
WHERE event_trail_events.organization_id = sqlc.arg(organization_id)
  AND event_trail_events.created_at >= sqlc.arg(retained_after)
  AND (
    sqlc.narg(workspace_id)::text IS NULL
    OR event_trail_events.workspace_id = sqlc.narg(workspace_id)::text
  )
ORDER BY target_type;

-- name: GatewayListEventTrailWorkspaces :many
SELECT
  event_trail_events.workspace_id,
  workspaces.name,
  workspaces.slug
FROM event_trail_events
LEFT JOIN workspaces
  ON workspaces.id = event_trail_events.workspace_id
  AND workspaces.organization_id = event_trail_events.organization_id
WHERE event_trail_events.organization_id = sqlc.arg(organization_id)
  AND event_trail_events.workspace_id IS NOT NULL
  AND event_trail_events.created_at >= sqlc.arg(retained_after)
  AND (
    sqlc.narg(workspace_id)::text IS NULL
    OR event_trail_events.workspace_id = sqlc.narg(workspace_id)::text
  )
GROUP BY event_trail_events.workspace_id, workspaces.name, workspaces.slug
ORDER BY workspaces.name, event_trail_events.workspace_id;

-- name: GatewayDeleteExpiredEventTrailEvents :execrows
DELETE FROM event_trail_events
WHERE created_at < sqlc.arg(expires_before);

-- name: GatewayListFileEventsAggregated :many
SELECT
  agent_name,
  MAX(event_time)::timestamptz AS last_seen,
  file_path_accessed,
  process,
  command_invocation,
  action,
  source,
  COUNT(*) AS occurrences
FROM observer_file_events
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND event_time >= sqlc.arg(event_time_after)
  AND event_time <= sqlc.arg(event_time_before)
  AND (
    sqlc.arg(action)::text = ''
    OR action = sqlc.arg(action)
  )
GROUP BY agent_name, file_path_accessed, process, command_invocation, action, source
HAVING (
  NOT sqlc.arg(cursor_set)::bool
  OR MAX(event_time) < sqlc.arg(cursor_event_time)
)
ORDER BY MAX(event_time) DESC
LIMIT sqlc.arg(page_size);

-- name: GatewayListNetworkEvents :many
SELECT
  id,
  agent_name,
  event_time,
  ingested_at,
  pod_namespace,
  pod_name,
  destination_domain,
  destination_ip,
  destination_port,
  protocol,
  action,
  source
FROM observer_network_events
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND event_time >= sqlc.arg(event_time_after)
  AND event_time <= sqlc.arg(event_time_before)
  AND (
    sqlc.arg(action)::text = ''
    OR action = sqlc.arg(action)
  )
  AND (
    NOT sqlc.arg(cursor_set)::bool
    OR event_time < sqlc.arg(cursor_event_time)
    OR (
      event_time = sqlc.arg(cursor_event_time)
      AND id < sqlc.arg(cursor_id)
    )
  )
ORDER BY event_time DESC, id DESC
LIMIT sqlc.arg(page_size);

-- name: GatewayListNetworkEventsAggregated :many
SELECT
  agent_name,
  MAX(event_time)::timestamptz AS last_seen,
  destination_domain,
  destination_ip,
  destination_port,
  protocol,
  action,
  source,
  COUNT(*) AS occurrences
FROM observer_network_events
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND event_time >= sqlc.arg(event_time_after)
  AND event_time <= sqlc.arg(event_time_before)
  AND (
    sqlc.arg(action)::text = ''
    OR action = sqlc.arg(action)
  )
GROUP BY agent_name, destination_domain, destination_ip, destination_port,
         protocol, action, source
HAVING (
  NOT sqlc.arg(cursor_set)::bool
  OR MAX(event_time) < sqlc.arg(cursor_event_time)
)
ORDER BY MAX(event_time) DESC
LIMIT sqlc.arg(page_size);
