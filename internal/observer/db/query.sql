-- name: InsertGuardrailEvent :execrows
INSERT INTO observer_guardrail_events (
  id, organization_id, workspace_id, occurred_at, expires_at, sandbox_name, agent_name,
  client_id, session_id, model, trace_id, span_id, evaluation_index, revision, phase, action, evaluation
) VALUES (
  sqlc.arg(id), sqlc.arg(organization_id), sqlc.arg(workspace_id), sqlc.arg(occurred_at),
  sqlc.arg(expires_at), sqlc.arg(sandbox_name), sqlc.arg(agent_name), sqlc.arg(client_id),
  sqlc.arg(session_id), sqlc.arg(model), sqlc.arg(trace_id), sqlc.arg(span_id),
  sqlc.arg(evaluation_index), sqlc.arg(revision), sqlc.arg(phase), sqlc.arg(action),
  sqlc.arg(evaluation)
)
ON CONFLICT (id) DO NOTHING;

-- name: GuardrailEventChanged :one
SELECT COALESCE(evaluation <> sqlc.arg(evaluation)::jsonb OR revision <> sqlc.arg(revision)::text, false)::boolean AS changed
FROM observer_guardrail_events WHERE id = sqlc.arg(id);

-- name: GetGuardrailSubjectScope :one
SELECT o.id AS organization_id, ''::text AS workspace_id
FROM organizations o
-- ScopeNamespace hashes the typed scope and stable ID, separated by a NUL byte.
WHERE 'org-' || substring(encode(sha256(
  convert_to('Organisation', 'UTF8') || decode('00', 'hex') || convert_to(o.id, 'UTF8')
), 'hex'), 1, 32) = sqlc.arg(namespace)
UNION ALL
SELECT w.organization_id, w.id AS workspace_id
FROM workspaces w WHERE w.namespace = sqlc.arg(namespace);

-- name: DeleteExpiredGuardrailEvents :execrows
DELETE FROM observer_guardrail_events WHERE expires_at <= now();

-- name: InsertProcessEvents :copyfrom
INSERT INTO observer_process_events(
  tenant_namespace,
  agent_name,
  event_time,
  pod_namespace,
  pod_name,
  process,
  parent_process,
  command_invocation,
  action,
  source
) VALUES (
  sqlc.arg(tenant_namespace),
  sqlc.arg(agent_name),
  sqlc.arg(event_time),
  sqlc.arg(pod_namespace),
  sqlc.arg(pod_name),
  sqlc.arg(process),
  sqlc.arg(parent_process),
  sqlc.arg(command_invocation),
  sqlc.arg(action),
  sqlc.arg(source)
);

-- name: InsertFileEvents :copyfrom
INSERT INTO observer_file_events(
  tenant_namespace,
  agent_name,
  event_time,
  pod_namespace,
  pod_name,
  file_path_accessed,
  process,
  command_invocation,
  action,
  source
) VALUES (
  sqlc.arg(tenant_namespace),
  sqlc.arg(agent_name),
  sqlc.arg(event_time),
  sqlc.arg(pod_namespace),
  sqlc.arg(pod_name),
  sqlc.arg(file_path_accessed),
  sqlc.arg(process),
  sqlc.arg(command_invocation),
  sqlc.arg(action),
  sqlc.arg(source)
);

-- name: InsertNetworkEvents :copyfrom
INSERT INTO observer_network_events(
  tenant_namespace,
  agent_name,
  event_time,
  pod_namespace,
  pod_name,
  destination_domain,
  destination_ip,
  destination_port,
  protocol,
  action,
  source
) VALUES (
  sqlc.arg(tenant_namespace),
  sqlc.arg(agent_name),
  sqlc.arg(event_time),
  sqlc.arg(pod_namespace),
  sqlc.arg(pod_name),
  sqlc.arg(destination_domain),
  sqlc.arg(destination_ip),
  sqlc.arg(destination_port),
  sqlc.arg(protocol),
  sqlc.arg(action),
  sqlc.arg(source)
);

-- name: InsertTraceSpan :batchexec
INSERT INTO observer_trace_spans(
  tenant_namespace,
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
  span_attributes
) VALUES (
  sqlc.arg(tenant_namespace),
  sqlc.arg(agent_name),
  sqlc.arg(session_id),
  sqlc.arg(trace_id),
  sqlc.arg(span_id),
  sqlc.arg(parent_span_id),
  sqlc.arg(start_time),
  sqlc.arg(end_time),
  sqlc.arg(duration_ns),
  sqlc.arg(name),
  sqlc.arg(span_class),
  sqlc.arg(operation_name),
  sqlc.arg(kind),
  sqlc.arg(status_code),
  sqlc.arg(error_type),
  sqlc.arg(error_message),
  sqlc.arg(model),
  sqlc.arg(tool_name),
  sqlc.arg(input_tokens),
  sqlc.arg(output_tokens),
  sqlc.arg(cached_input_tokens),
  sqlc.arg(cached_write_tokens),
  sqlc.arg(cost_usd),
  sqlc.arg(llm_finish_reason),
  sqlc.arg(resource_attributes),
  sqlc.arg(span_attributes)
)
ON CONFLICT(trace_id, span_id, start_time) DO NOTHING;

-- name: InsertTraceSpanPayload :batchexec
INSERT INTO observer_trace_span_payloads(
  trace_id,
  span_id,
  start_time,
  input_messages,
  output_messages,
  tool_arguments,
  tool_result
) VALUES (
  sqlc.arg(trace_id),
  sqlc.arg(span_id),
  sqlc.arg(start_time),
  sqlc.arg(input_messages),
  sqlc.arg(output_messages),
  sqlc.arg(tool_arguments),
  sqlc.arg(tool_result)
)
ON CONFLICT(trace_id, span_id, start_time) DO NOTHING;

-- name: InsertMCPToolInvocation :batchexec
INSERT INTO observer_mcp_tool_invocations(
  tenant_namespace,
  agent_name,
  trace_id,
  span_id,
  start_time,
  end_time,
  duration_ns,
  mcp_connection_name,
  tool_name,
  session_id,
  failed
) VALUES (
  sqlc.arg(tenant_namespace),
  sqlc.arg(agent_name),
  sqlc.arg(trace_id),
  sqlc.arg(span_id),
  sqlc.arg(start_time),
  sqlc.arg(end_time),
  sqlc.arg(duration_ns),
  sqlc.arg(mcp_connection_name),
  sqlc.arg(tool_name),
  sqlc.arg(session_id),
  sqlc.arg(failed)
)
ON CONFLICT(trace_id, span_id, start_time) DO NOTHING;

-- name: RefreshTraceSummary :batchexec
INSERT INTO observer_traces(
  trace_id,
  tenant_namespace,
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
) SELECT
  observer_trace_spans.trace_id,
  (ARRAY_AGG(tenant_namespace ORDER BY start_time ASC))[1],
  (ARRAY_AGG(agent_name ORDER BY start_time ASC))[1],
  COALESCE(
    (ARRAY_AGG(span_id ORDER BY
      CASE WHEN parent_span_id = ''::BYTEA THEN 0 ELSE 1 END,
      start_time ASC
    ))[1],
    ''::BYTEA
  ),
  MIN(start_time),
  MAX(end_time),
  GREATEST(
    0,
    (EXTRACT(EPOCH FROM (MAX(end_time) - MIN(start_time))) * 1000000000)::BIGINT
  ),
  COUNT(*)::BIGINT,
  COUNT(*) FILTER (
    WHERE status_code = 'ERROR' OR error_type != '' OR error_message != ''
  )::BIGINT,
  COUNT(*) FILTER (
    WHERE span_class = 'tool'
  )::BIGINT,
  COUNT(*) FILTER (
    WHERE span_class = 'llm'
  )::BIGINT,
  COALESCE(SUM(input_tokens) FILTER (WHERE span_class = 'llm'), 0)::BIGINT,
  COALESCE(SUM(output_tokens) FILTER (WHERE span_class = 'llm'), 0)::BIGINT,
  COALESCE(SUM(cached_input_tokens) FILTER (WHERE span_class = 'llm'), 0)::BIGINT,
  COALESCE(SUM(cached_write_tokens) FILTER (WHERE span_class = 'llm'), 0)::BIGINT,
  COALESCE(SUM(cost_usd) FILTER (WHERE span_class = 'llm'), 0)::DOUBLE PRECISION,
  CASE
    WHEN COUNT(*) FILTER (
      WHERE status_code = 'ERROR' OR error_type != '' OR error_message != ''
    ) > 0 THEN 'ERROR'
    WHEN COUNT(*) FILTER (WHERE status_code = 'OK') > 0 THEN 'OK'
    ELSE ''
  END,
  now()
FROM observer_trace_spans
WHERE observer_trace_spans.trace_id = sqlc.arg(trace_id)
GROUP BY observer_trace_spans.trace_id
ON CONFLICT(trace_id) DO UPDATE SET
  tenant_namespace = EXCLUDED.tenant_namespace,
  agent_name = EXCLUDED.agent_name,
  root_span_id = EXCLUDED.root_span_id,
  started_at = EXCLUDED.started_at,
  ended_at = EXCLUDED.ended_at,
  duration_ns = EXCLUDED.duration_ns,
  span_count = EXCLUDED.span_count,
  error_count = EXCLUDED.error_count,
  tool_count = EXCLUDED.tool_count,
  model_count = EXCLUDED.model_count,
  input_tokens = EXCLUDED.input_tokens,
  output_tokens = EXCLUDED.output_tokens,
  cached_input_tokens = EXCLUDED.cached_input_tokens,
  cached_write_tokens = EXCLUDED.cached_write_tokens,
  cost_usd = EXCLUDED.cost_usd,
  status_code = EXCLUDED.status_code,
  updated_at = now();

-- name: RefreshTraceSessionSummary :batchexec
INSERT INTO observer_trace_sessions(
  trace_id,
  session_id,
  tenant_namespace,
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
) SELECT
  observer_trace_spans.trace_id,
  sqlc.arg(session_id),
  (ARRAY_AGG(tenant_namespace ORDER BY start_time ASC))[1],
  (ARRAY_AGG(agent_name ORDER BY start_time ASC))[1],
  COALESCE(
    (ARRAY_AGG(span_id ORDER BY
      CASE WHEN parent_span_id = ''::BYTEA THEN 0 ELSE 1 END,
      start_time ASC
    ))[1],
    ''::BYTEA
  ),
  MIN(start_time),
  MAX(end_time),
  GREATEST(
    0,
    (EXTRACT(EPOCH FROM (MAX(end_time) - MIN(start_time))) * 1000000000)::BIGINT
  ),
  COUNT(*)::BIGINT,
  COUNT(*) FILTER (
    WHERE status_code = 'ERROR' OR error_type != '' OR error_message != ''
  )::BIGINT,
  COUNT(*) FILTER (
    WHERE span_class = 'tool'
  )::BIGINT,
  COUNT(*) FILTER (
    WHERE span_class = 'llm'
  )::BIGINT,
  COALESCE(SUM(input_tokens) FILTER (WHERE span_class = 'llm'), 0)::BIGINT,
  COALESCE(SUM(output_tokens) FILTER (WHERE span_class = 'llm'), 0)::BIGINT,
  COALESCE(SUM(cached_input_tokens) FILTER (WHERE span_class = 'llm'), 0)::BIGINT,
  COALESCE(SUM(cached_write_tokens) FILTER (WHERE span_class = 'llm'), 0)::BIGINT,
  COALESCE(SUM(cost_usd) FILTER (WHERE span_class = 'llm'), 0)::DOUBLE PRECISION,
  CASE
    WHEN COUNT(*) FILTER (
      WHERE status_code = 'ERROR' OR error_type != '' OR error_message != ''
    ) > 0 THEN 'ERROR'
    WHEN COUNT(*) FILTER (WHERE status_code = 'OK') > 0 THEN 'OK'
    ELSE ''
  END,
  now()
FROM observer_trace_spans
WHERE observer_trace_spans.trace_id = sqlc.arg(trace_id)
  AND observer_trace_spans.session_id = sqlc.arg(session_id)
GROUP BY observer_trace_spans.trace_id
ON CONFLICT(trace_id, session_id) DO UPDATE SET
  tenant_namespace = EXCLUDED.tenant_namespace,
  agent_name = EXCLUDED.agent_name,
  root_span_id = EXCLUDED.root_span_id,
  started_at = EXCLUDED.started_at,
  ended_at = EXCLUDED.ended_at,
  duration_ns = EXCLUDED.duration_ns,
  span_count = EXCLUDED.span_count,
  error_count = EXCLUDED.error_count,
  tool_count = EXCLUDED.tool_count,
  model_count = EXCLUDED.model_count,
  input_tokens = EXCLUDED.input_tokens,
  output_tokens = EXCLUDED.output_tokens,
  cached_input_tokens = EXCLUDED.cached_input_tokens,
  cached_write_tokens = EXCLUDED.cached_write_tokens,
  cost_usd = EXCLUDED.cost_usd,
  status_code = EXCLUDED.status_code,
  updated_at = now();

-- name: InsertAppOperation :batchone
WITH operation AS (
  INSERT INTO observer_app_operations (
    organization_id,
    workspace_id,
    client_id,
    app_name,
    grant_id,
    user_id,
    resource_kind,
    resource_namespace,
    resource_name,
    resource_uid,
    target_id,
    trace_id,
    span_id,
    parent_span_id,
    start_time,
    end_time,
    duration_ns,
    name,
    span_class,
    operation_name,
    status_code,
    error_type,
    error_message,
    model,
    tool_name,
    session_id,
    turn_id,
    agent_kind,
    tool_call_id,
    input_tokens,
    output_tokens,
    reasoning_tokens,
    cached_input_tokens,
    cached_write_tokens,
    cost_usd
  ) VALUES (
    sqlc.arg(organization_id),
    sqlc.arg(workspace_id),
    sqlc.arg(client_id),
    sqlc.arg(app_name),
    sqlc.arg(grant_id),
    sqlc.arg(user_id),
    sqlc.arg(resource_kind),
    sqlc.arg(resource_namespace),
    sqlc.arg(resource_name),
    sqlc.arg(resource_uid),
    sqlc.arg(target_id),
    sqlc.arg(trace_id),
    sqlc.arg(span_id),
    sqlc.arg(parent_span_id),
    sqlc.arg(start_time),
    sqlc.arg(end_time),
    sqlc.arg(duration_ns),
    sqlc.arg(name),
    sqlc.arg(span_class),
    sqlc.arg(operation_name),
    sqlc.arg(status_code),
    sqlc.arg(error_type),
    sqlc.arg(error_message),
    sqlc.arg(model),
    sqlc.arg(tool_name),
    sqlc.arg(session_id),
    sqlc.arg(turn_id),
    sqlc.arg(agent_kind),
    sqlc.arg(tool_call_id),
    sqlc.narg(input_tokens),
    sqlc.narg(output_tokens),
    sqlc.narg(reasoning_tokens),
    sqlc.narg(cached_input_tokens),
    sqlc.narg(cached_write_tokens),
    sqlc.narg(cost_usd)
  )
  ON CONFLICT (organization_id, workspace_id, client_id, trace_id, span_id, start_time) DO NOTHING
  RETURNING *
), run AS (
  INSERT INTO observer_app_operations (
    organization_id, workspace_id, client_id, app_name, grant_id, user_id,
    resource_kind, resource_namespace, resource_name, resource_uid, target_id,
    trace_id, span_id, start_time, end_time, duration_ns, name, span_class, operation_name,
    status_code, session_id, turn_id, agent_kind
  )
  SELECT organization_id, workspace_id, client_id, app_name, grant_id, user_id,
    'turn', resource_namespace, resource_name, resource_uid, target_id,
    uuid_send(gen_random_uuid()), substring(uuid_send(gen_random_uuid()) from 1 for 8),
    start_time, end_time, duration_ns, 'Agent turn', 'session', 'invoke_agent', status_code,
    session_id, turn_id, agent_kind
  FROM operation
  WHERE agent_kind IN ('claude', 'codex') AND session_id <> '' AND turn_id <> ''
  ON CONFLICT (organization_id, workspace_id, client_id, user_id, session_id, turn_id) WHERE resource_kind = 'turn'
  DO UPDATE SET
    start_time = LEAST(observer_app_operations.start_time, EXCLUDED.start_time),
    end_time = GREATEST(observer_app_operations.end_time, EXCLUDED.end_time),
    duration_ns = (EXTRACT(EPOCH FROM GREATEST(observer_app_operations.end_time, EXCLUDED.end_time)
      - LEAST(observer_app_operations.start_time, EXCLUDED.start_time)) * 1000000000)::bigint,
    status_code = CASE WHEN observer_app_operations.status_code = 'ERROR' THEN 'ERROR' ELSE EXCLUDED.status_code END,
    ingested_at = now()
  RETURNING id
), output_calls AS MATERIALIZED (
  SELECT DISTINCT ON (item.value->>'id') item.value->>'id' AS call_id,
    item.value->>'name' AS name, item.value->'arguments' AS arguments
  FROM operation op
  CROSS JOIN LATERAL jsonb_path_query(sqlc.arg(output_messages)::jsonb, '$.tool_calls[*]') WITH ORDINALITY AS item(value, ordinal)
  WHERE op.resource_kind = 'inference'
    AND octet_length(item.value->>'id') BETWEEN 1 AND 512 AND item.value->>'name' <> ''
  ORDER BY item.value->>'id', item.ordinal
), tools AS (
  INSERT INTO observer_app_operations (
    organization_id, workspace_id, client_id, app_name, grant_id, user_id,
    resource_kind, resource_namespace, resource_name, resource_uid, target_id,
    trace_id, span_id, parent_span_id, start_time, end_time, duration_ns, name, span_class, operation_name,
    status_code, tool_name, session_id, turn_id, agent_kind, tool_call_id, source_operation_id
  )
  SELECT op.organization_id, op.workspace_id, op.client_id, op.app_name, op.grant_id, op.user_id,
    'tool', op.resource_namespace, op.resource_name, op.resource_uid, op.target_id,
    op.trace_id, substring(uuid_send(gen_random_uuid()) from 1 for 8), op.span_id, op.end_time, op.end_time, 0,
    call.name, 'tool', 'execute_tool', 'UNSET', call.name, op.session_id, op.turn_id,
    op.agent_kind, call.call_id, op.id
  FROM operation op CROSS JOIN output_calls call
  ON CONFLICT DO NOTHING
  RETURNING id, tool_call_id
), tool_payloads AS (
  INSERT INTO observer_app_operation_payloads (operation_id, tool_arguments)
  SELECT tools.id, COALESCE(call.arguments, 'null'::jsonb) FROM tools JOIN output_calls call ON call.call_id = tools.tool_call_id
), input_results AS MATERIALIZED (
  SELECT block.value->>'tool_use_id' AS call_id,
    COALESCE(block.value->'is_error' = 'true'::jsonb, false) AS is_error, block.ordinal, 'messages'::text AS protocol
  FROM jsonb_path_query(sqlc.arg(input_messages)::jsonb,
    '$.messages[*] ? (@.role == "user").content[*] ? (@.type == "tool_result")') WITH ORDINALITY block(value, ordinal)
  WHERE block.value ? 'content'
  UNION ALL
  SELECT block.value->>'call_id', false, block.ordinal, 'responses'::text
  FROM jsonb_path_query(sqlc.arg(input_messages)::jsonb,
    '$.input[*] ? (@.type == "function_call_output" || @.type == "custom_tool_call_output")') WITH ORDINALITY block(value, ordinal)
  WHERE block.value ? 'output'
  UNION ALL
  SELECT block.value->>'tool_call_id', false, block.ordinal, 'chat'::text
  FROM jsonb_path_query(sqlc.arg(input_messages)::jsonb,
    '$.messages[*] ? (@.role == "tool")') WITH ORDINALITY block(value, ordinal)
  WHERE block.value ? 'content'
), results AS (
  INSERT INTO observer_app_tool_results (
    organization_id, workspace_id, client_id, user_id, session_id, tool_call_id,
    source_operation_id, source_start_time, source_ordinal, protocol, is_error
  )
  SELECT op.organization_id, op.workspace_id, op.client_id, op.user_id, op.session_id, input.call_id,
    op.id, op.start_time, input.ordinal, input.protocol, input.is_error
  FROM operation op CROSS JOIN input_results input
  WHERE op.resource_kind = 'inference' AND octet_length(input.call_id) BETWEEN 1 AND 512
  ON CONFLICT (source_operation_id, protocol, source_ordinal) DO NOTHING
), payload AS (
  INSERT INTO observer_app_operation_payloads (operation_id, input_messages, output_messages, tool_arguments, tool_result, tool_error)
  SELECT id, sqlc.arg(input_messages), sqlc.arg(output_messages), sqlc.arg(tool_arguments), sqlc.arg(tool_result), sqlc.arg(tool_error)
  FROM operation
)
SELECT COALESCE((SELECT id FROM operation), 0)::bigint AS id;

-- name: LockAppInvocationKeys :exec
SELECT pg_advisory_xact_lock(hashtextextended(key, 0))
FROM (SELECT DISTINCT unnest(sqlc.arg(keys)::text[]) AS key ORDER BY key) ordered;

-- name: AssignAppRuns :exec
UPDATE observer_app_operations op SET run_id = run.id
FROM observer_app_operations run
WHERE op.id = ANY(sqlc.arg(operation_ids)::bigint[]) AND op.agent_kind IN ('claude', 'codex')
  AND op.resource_kind <> 'turn' AND run.resource_kind = 'turn'
  AND run.organization_id = op.organization_id AND run.workspace_id = op.workspace_id
  AND run.client_id = op.client_id AND run.user_id = op.user_id
  AND run.session_id = op.session_id AND run.turn_id = op.turn_id;

-- name: AssignAppToolRuns :exec
UPDATE observer_app_operations tool SET run_id = source.run_id
FROM observer_app_operations source
WHERE source.id = ANY(sqlc.arg(operation_ids)::bigint[]) AND tool.source_operation_id = source.id
  AND tool.resource_kind = 'tool' AND tool.run_id IS DISTINCT FROM source.run_id;

-- name: RefreshAppRunCorrelations :exec
WITH affected AS MATERIALIZED (
  SELECT key->>'organization_id' AS organization_id, key->>'workspace_id' AS workspace_id,
    key->>'client_id' AS client_id, key->>'user_id' AS user_id, key->>'call_id' AS call_id
  FROM jsonb_array_elements(sqlc.arg(invocations)::jsonb) AS key
), matches AS (
  SELECT mcp.id, CASE WHEN COUNT(tool.run_id) = COUNT(tool.id) AND COUNT(DISTINCT tool.run_id) = 1 THEN MIN(tool.run_id) END AS run_id
  FROM affected key
  JOIN observer_app_operations mcp ON mcp.organization_id = key.organization_id AND mcp.workspace_id = key.workspace_id
    AND mcp.client_id = key.client_id AND mcp.user_id = key.user_id AND mcp.tool_call_id = key.call_id
    -- Explicit nonempty IDs keep correlation probes on the partial call index.
    AND mcp.tool_call_id <> ''
    AND mcp.resource_kind = 'mcp' AND mcp.agent_kind IN ('claude', 'codex')
    AND (mcp.session_id = '' OR mcp.turn_id = '')
  LEFT JOIN observer_app_operations tool ON tool.organization_id = mcp.organization_id AND tool.workspace_id = mcp.workspace_id
    AND tool.client_id = mcp.client_id AND tool.user_id = mcp.user_id AND tool.tool_call_id = mcp.tool_call_id
    AND tool.resource_kind = 'tool' AND tool.agent_kind = mcp.agent_kind
    AND tool.tool_call_id <> ''
    AND (mcp.session_id = '' OR tool.session_id = mcp.session_id)
    AND (mcp.turn_id = '' OR tool.turn_id = mcp.turn_id)
  GROUP BY mcp.id
)
UPDATE observer_app_operations mcp SET run_id = matches.run_id
FROM matches WHERE mcp.id = matches.id AND mcp.run_id IS DISTINCT FROM matches.run_id;

-- name: RefreshAppToolResults :exec
WITH affected AS MATERIALIZED (
  SELECT key->>'organization_id' AS organization_id, key->>'workspace_id' AS workspace_id,
    key->>'client_id' AS client_id, key->>'user_id' AS user_id, key->>'call_id' AS call_id
  FROM jsonb_array_elements(sqlc.arg(invocations)::jsonb) AS key
), calls AS MATERIALIZED (
  SELECT tool.id, tool.organization_id, tool.workspace_id, tool.client_id, tool.user_id,
    tool.session_id, tool.tool_call_id, tool.source_operation_id, source.start_time AS emitted_source_time
  FROM affected key JOIN observer_app_operations tool
    ON tool.organization_id = key.organization_id AND tool.workspace_id = key.workspace_id
    AND tool.client_id = key.client_id AND tool.user_id = key.user_id AND tool.tool_call_id = key.call_id
    AND tool.resource_kind = 'tool' AND tool.tool_call_id <> ''
  JOIN observer_app_operations source ON source.id = tool.source_operation_id
), matches AS (
  SELECT tool.id, (
    SELECT result.id FROM observer_app_tool_results result
    WHERE result.organization_id = tool.organization_id AND result.workspace_id = tool.workspace_id
      AND result.client_id = tool.client_id AND result.user_id = tool.user_id
      AND result.session_id = tool.session_id AND result.tool_call_id = tool.tool_call_id
      -- Input history cannot be a result of the response to that same request.
      AND result.source_operation_id <> tool.source_operation_id
      AND result.source_start_time > tool.emitted_source_time
      -- Reused IDs are ambiguous once more than one emitted occurrence could
      -- own this result. Request turn metadata does not identify historical results.
      AND (SELECT COUNT(*) FROM calls other
        WHERE other.organization_id = tool.organization_id AND other.workspace_id = tool.workspace_id
          AND other.client_id = tool.client_id AND other.user_id = tool.user_id
          AND other.session_id = tool.session_id AND other.tool_call_id = tool.tool_call_id
          AND other.source_operation_id <> result.source_operation_id
          AND other.emitted_source_time < result.source_start_time) = 1
    ORDER BY result.source_start_time, result.source_ordinal, result.source_operation_id, result.id LIMIT 1
  ) AS result_id FROM calls tool
)
UPDATE observer_app_operations tool SET result_id = matches.result_id
FROM matches WHERE tool.id = matches.id AND tool.result_id IS DISTINCT FROM matches.result_id;

-- name: RefreshAppRunStatuses :exec
WITH affected AS MATERIALIZED (
  SELECT key->>'organization_id' AS organization_id, key->>'workspace_id' AS workspace_id,
    key->>'client_id' AS client_id, key->>'user_id' AS user_id, key->>'call_id' AS call_id
  FROM jsonb_array_elements(sqlc.arg(invocations)::jsonb) AS key
), runs AS (
  SELECT op.run_id AS id FROM observer_app_operations op WHERE op.id = ANY(sqlc.arg(operation_ids)::bigint[])
  UNION
  SELECT op.run_id FROM affected key JOIN observer_app_operations op
    ON op.organization_id = key.organization_id AND op.workspace_id = key.workspace_id
    AND op.client_id = key.client_id AND op.user_id = key.user_id AND op.tool_call_id = key.call_id
    AND op.tool_call_id <> ''
)
UPDATE observer_app_operations root SET
  status_code = CASE WHEN EXISTS (
    SELECT 1 FROM observer_app_spans span WHERE span.run_id = root.id AND span.visible AND span.status_code = 'ERROR'
  ) THEN 'ERROR' ELSE 'OK' END,
  start_time = summary.started_at,
  end_time = summary.ended_at,
  duration_ns = (EXTRACT(EPOCH FROM summary.ended_at - summary.started_at) * 1000000000)::bigint,
  ingested_at = summary.updated_at
FROM (
  SELECT op.run_id, MIN(op.start_time)::timestamptz AS started_at, MAX(op.end_time)::timestamptz AS ended_at,
    MAX(op.ingested_at)::timestamptz AS updated_at
  FROM observer_app_operations op WHERE op.run_id IN (SELECT id FROM runs) GROUP BY op.run_id
) summary
WHERE root.id = summary.run_id AND root.resource_kind = 'turn';
