-- name: ListProcessEventsBetween :many
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
  AND event_time >= sqlc.arg(updated_after)::timestamptz
  AND event_time <= sqlc.arg(updated_before)::timestamptz
ORDER BY event_time ASC, id ASC
LIMIT sqlc.arg(page_size);

-- name: InsertTraceSpan :batchexec
INSERT INTO observer_trace_spans(
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
  span_attributes
) VALUES (
  sqlc.arg(agent_name),
  sqlc.arg(session_id),
  sqlc.arg(trace_id),
  sqlc.arg(span_id),
  sqlc.arg(parent_span_id),
  sqlc.arg(start_time),
  sqlc.arg(end_time),
  sqlc.arg(duration_ns),
  sqlc.arg(duration_ms),
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

-- name: RefreshTraceSummary :batchexec
INSERT INTO observer_traces(
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
) SELECT
  observer_trace_spans.trace_id,
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
  GREATEST(
    0,
    EXTRACT(EPOCH FROM (MAX(end_time) - MIN(start_time))) * 1000
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
  agent_name = EXCLUDED.agent_name,
  root_span_id = EXCLUDED.root_span_id,
  started_at = EXCLUDED.started_at,
  ended_at = EXCLUDED.ended_at,
  duration_ns = EXCLUDED.duration_ns,
  duration_ms = EXCLUDED.duration_ms,
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
) SELECT
  observer_trace_spans.trace_id,
  sqlc.arg(session_id),
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
  GREATEST(
    0,
    EXTRACT(EPOCH FROM (MAX(end_time) - MIN(start_time))) * 1000
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
  agent_name = EXCLUDED.agent_name,
  root_span_id = EXCLUDED.root_span_id,
  started_at = EXCLUDED.started_at,
  ended_at = EXCLUDED.ended_at,
  duration_ns = EXCLUDED.duration_ns,
  duration_ms = EXCLUDED.duration_ms,
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

-- name: ListFileEventsBetween :many
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
  AND event_time >= sqlc.arg(updated_after)::timestamptz
  AND event_time <= sqlc.arg(updated_before)::timestamptz
ORDER BY event_time ASC, id ASC
LIMIT sqlc.arg(page_size);

-- name: ListNetworkEventsBetween :many
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
  AND event_time >= sqlc.arg(updated_after)::timestamptz
  AND event_time <= sqlc.arg(updated_before)::timestamptz
ORDER BY event_time ASC, id ASC
LIMIT sqlc.arg(page_size);
