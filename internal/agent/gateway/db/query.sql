-- name: GatewaySessionExists :one
SELECT EXISTS(
  SELECT 1
  FROM sessions
  WHERE session_id = $1
);

-- name: GatewayCreateSession :one
INSERT INTO sessions(session_id, agent_name)
VALUES ($1, $2)
RETURNING session_id, agent_name, created_at, updated_at;

-- name: GatewayGetSession :one
SELECT session_id, agent_name, created_at, updated_at
FROM sessions
WHERE session_id = $1;

-- name: GatewayDeleteSession :execrows
DELETE FROM sessions
WHERE session_id = $1;

-- name: GatewayListRecentEvents :many
SELECT seq, event_id, event_ts, event_payload
FROM session_events
WHERE session_id = $1
ORDER BY seq DESC
LIMIT $2;

-- name: GatewayListEventPage :many
SELECT seq, event_id, event_ts, event_payload
FROM session_events
WHERE session_id = $1
  AND seq < $2
ORDER BY seq DESC
LIMIT $3;

-- name: GatewayListSessions :many
SELECT session_id, agent_name, created_at, updated_at
FROM sessions
ORDER BY updated_at DESC, session_id DESC
LIMIT $1 OFFSET $2;

-- name: GatewayListSessionsByID :many
SELECT session_id, agent_name, created_at, updated_at
FROM sessions
WHERE session_id = ANY($1::uuid[])
ORDER BY updated_at DESC, session_id DESC
LIMIT $2 OFFSET $3;

-- name: GatewayListTraces :many
SELECT
  trace_id,
  session_id,
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
WHERE session_id = sqlc.arg(session_id)
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
  session_id,
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
WHERE session_id = sqlc.arg(session_id)
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
    session_id,
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
  WHERE sp.session_id = sqlc.arg(session_id)
    AND sp.trace_id = sqlc.arg(trace_id)
    AND sp.span_id = sqlc.arg(span_id)
  ORDER BY sp.start_time ASC, sp.id ASC
  LIMIT 1
)
SELECT
  s.id,
  s.session_id,
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
  COALESCE(p.metadata, '{}'::jsonb) AS metadata,
  convert_to(COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', e.id,
      'session_id', e.session_id,
      'event_time', e.event_time,
      'ingested_at', e.ingested_at,
      'pod_namespace', e.pod_namespace,
      'pod_name', e.pod_name,
      'process', e.process,
      'parent_process', e.parent_process,
      'command_invocation', e.command_invocation,
      'action', e.action,
      'source', e.source
    ) ORDER BY e.event_time ASC, e.id ASC)
    FROM (
      SELECT
        id,
        session_id,
        event_time,
        ingested_at,
        pod_namespace,
        pod_name,
        process,
        parent_process,
        command_invocation,
        action,
        source
      FROM observer_process_events e
      WHERE s.pod_namespace != ''
        AND s.pod_name != ''
        AND e.session_id = s.session_id
        AND e.event_time >= s.start_time - INTERVAL '5 seconds'
        AND e.event_time <= s.end_time + INTERVAL '5 seconds'
        AND e.pod_namespace = s.pod_namespace
        AND e.pod_name = s.pod_name
      ORDER BY e.event_time ASC, e.id ASC
      LIMIT 50
    ) e
  ), '[]'::jsonb)::text, 'UTF8') AS process_events,
  convert_to(COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', e.id,
      'session_id', e.session_id,
      'event_time', e.event_time,
      'ingested_at', e.ingested_at,
      'pod_namespace', e.pod_namespace,
      'pod_name', e.pod_name,
      'file_path_accessed', e.file_path_accessed,
      'process', e.process,
      'command_invocation', e.command_invocation,
      'action', e.action,
      'source', e.source
    ) ORDER BY e.event_time ASC, e.id ASC)
    FROM (
      SELECT
        id,
        session_id,
        event_time,
        ingested_at,
        pod_namespace,
        pod_name,
        file_path_accessed,
        process,
        command_invocation,
        action,
        source
      FROM observer_file_events e
      WHERE s.pod_namespace != ''
        AND s.pod_name != ''
        AND e.session_id = s.session_id
        AND e.event_time >= s.start_time - INTERVAL '5 seconds'
        AND e.event_time <= s.end_time + INTERVAL '5 seconds'
        AND e.pod_namespace = s.pod_namespace
        AND e.pod_name = s.pod_name
      ORDER BY e.event_time ASC, e.id ASC
      LIMIT 50
    ) e
  ), '[]'::jsonb)::text, 'UTF8') AS file_events,
  convert_to(COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', e.id,
      'session_id', e.session_id,
      'event_time', e.event_time,
      'ingested_at', e.ingested_at,
      'pod_namespace', e.pod_namespace,
      'pod_name', e.pod_name,
      'destination_domain', e.destination_domain,
      'destination_ip', e.destination_ip,
      'destination_port', e.destination_port,
      'protocol', e.protocol,
      'action', e.action,
      'source', e.source
    ) ORDER BY e.event_time ASC, e.id ASC)
    FROM (
      SELECT
        id,
        session_id,
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
      FROM observer_network_events e
      WHERE s.pod_namespace != ''
        AND s.pod_name != ''
        AND e.session_id = s.session_id
        AND e.event_time >= s.start_time - INTERVAL '5 seconds'
        AND e.event_time <= s.end_time + INTERVAL '5 seconds'
        AND e.pod_namespace = s.pod_namespace
        AND e.pod_name = s.pod_name
      ORDER BY e.event_time ASC, e.id ASC
      LIMIT 50
    ) e
  ), '[]'::jsonb)::text, 'UTF8') AS network_events
FROM span_row s
LEFT JOIN observer_trace_span_payloads p
  ON p.trace_id = s.trace_id
  AND p.span_id = s.span_id
  AND p.start_time = s.start_time;

-- name: GatewayListProcessEvents :many
SELECT
  id,
  session_id,
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
WHERE session_id = sqlc.arg(session_id)
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
  session_id,
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
WHERE session_id = sqlc.arg(session_id)
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

-- name: GatewayListNetworkEvents :many
SELECT
  id,
  session_id,
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
WHERE session_id = sqlc.arg(session_id)
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
