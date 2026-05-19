-- name: GatewayAgentExists :one
SELECT EXISTS(
  SELECT 1
  FROM agents
  WHERE agent_name = $1
);

-- name: GatewayCreateAgent :one
INSERT INTO agents(agent_name)
VALUES ($1)
RETURNING agent_name, created_at, updated_at;

-- name: GatewayGetAgent :one
SELECT agent_name, created_at, updated_at
FROM agents
WHERE agent_name = $1;

-- name: GatewayDeleteAgent :execrows
DELETE FROM agents
WHERE agent_name = $1;

-- name: GatewayListAgents :many
SELECT agent_name, created_at, updated_at
FROM agents
ORDER BY updated_at DESC, agent_name DESC
LIMIT $1 OFFSET $2;

-- name: GatewayListAgentsByName :many
SELECT agent_name, created_at, updated_at
FROM agents
WHERE agent_name = ANY($1::text[])
ORDER BY updated_at DESC, agent_name DESC
LIMIT $2 OFFSET $3;

-- name: GatewayListTraces :many
SELECT
  trace_id,
  agent_name,
  root_span_id,
  started_at,
  ended_at,
  duration_ns,
  duration_ms,
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
FROM observer_traces
WHERE agent_name = sqlc.arg(agent_name)
  AND started_at >= sqlc.arg(started_after)
  AND started_at <= sqlc.arg(started_before)
  AND (
    NOT sqlc.arg(cursor_set)::bool
    OR started_at < sqlc.arg(cursor_started_at)
    OR (
      started_at = sqlc.arg(cursor_started_at)
      AND trace_id < sqlc.arg(cursor_trace_id)
    )
  )
ORDER BY started_at DESC, trace_id DESC
LIMIT sqlc.arg(page_size);

-- name: GatewayListTraceSessions :many
SELECT
  trace_id,
  session_id,
  agent_name,
  root_span_id,
  started_at,
  ended_at,
  duration_ns,
  duration_ms,
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
WHERE agent_name = sqlc.arg(agent_name)
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
  duration_ms,
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
WHERE agent_name = sqlc.arg(agent_name)
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
    duration_ms,
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
  WHERE sp.agent_name = sqlc.arg(agent_name)
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
  s.duration_ms,
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
WHERE agent_name = sqlc.arg(agent_name)
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
WHERE agent_name = sqlc.arg(agent_name)
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
WHERE agent_name = sqlc.arg(agent_name)
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
WHERE agent_name = sqlc.arg(agent_name)
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
WHERE agent_name = sqlc.arg(agent_name)
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
WHERE agent_name = sqlc.arg(agent_name)
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
