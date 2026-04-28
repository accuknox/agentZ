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
