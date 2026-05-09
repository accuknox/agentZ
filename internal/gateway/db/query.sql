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
  span_count,
  error_count,
  tool_count,
  model_count,
  run_id,
  request_id,
  conversation_id,
  input_tokens,
  output_tokens,
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

-- name: GatewayListSpans :many
SELECT
  id,
  agent_name,
  trace_id,
  span_id,
  parent_span_id,
  start_time,
  end_time,
  duration_ns,
  name,
  operation_name,
  kind,
  status_code,
  error_type,
  error_message,
  conversation_id,
  run_id,
  request_id,
  model,
  tool_name,
  input_tokens,
  output_tokens,
  cached_input_tokens,
  time_to_first_token_ms,
  pod_namespace,
  pod_name,
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
    trace_id,
    span_id,
    parent_span_id,
    start_time,
    end_time,
    duration_ns,
    name,
    operation_name,
    kind,
    status_code,
    error_type,
    error_message,
    conversation_id,
    run_id,
    request_id,
    model,
    tool_name,
    input_tokens,
    output_tokens,
    cached_input_tokens,
    time_to_first_token_ms,
    pod_namespace,
    pod_name,
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
  s.trace_id,
  s.span_id,
  s.parent_span_id,
  s.start_time,
  s.end_time,
  s.duration_ns,
  s.name,
  s.operation_name,
  s.kind,
  s.status_code,
  s.error_type,
  s.error_message,
  s.conversation_id,
  s.run_id,
  s.request_id,
  s.model,
  s.tool_name,
  s.input_tokens,
  s.output_tokens,
  s.cached_input_tokens,
  s.time_to_first_token_ms,
  s.pod_namespace,
  s.pod_name,
  s.ingested_at,
  COALESCE(p.input_messages, 'null'::jsonb) AS input_messages,
  COALESCE(p.output_messages, 'null'::jsonb) AS output_messages,
  COALESCE(p.tool_arguments, 'null'::jsonb) AS tool_arguments,
  COALESCE(p.tool_result, 'null'::jsonb) AS tool_result,
  COALESCE(p.metadata, '{}'::jsonb) AS metadata
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
