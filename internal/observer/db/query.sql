-- name: ListProcessEventsBetween :many
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
  AND event_time >= sqlc.arg(updated_after)::timestamptz
  AND event_time <= sqlc.arg(updated_before)::timestamptz
ORDER BY event_time ASC, id ASC
LIMIT sqlc.arg(page_size);

-- name: ListFileEventsBetween :many
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
  AND event_time >= sqlc.arg(updated_after)::timestamptz
  AND event_time <= sqlc.arg(updated_before)::timestamptz
ORDER BY event_time ASC, id ASC
LIMIT sqlc.arg(page_size);

-- name: ListNetworkEventsBetween :many
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
  AND event_time >= sqlc.arg(updated_after)::timestamptz
  AND event_time <= sqlc.arg(updated_before)::timestamptz
ORDER BY event_time ASC, id ASC
LIMIT sqlc.arg(page_size);
