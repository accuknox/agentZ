-- name: CreateSession :one
INSERT INTO sessions(session_id, agent_name)
VALUES ($1, $2)
RETURNING session_id, agent_name, created_at, updated_at;

-- name: GetSession :one
SELECT session_id, agent_name, created_at, updated_at
FROM sessions
WHERE session_id = $1;

-- name: ListSessions :many
SELECT session_id, agent_name, created_at, updated_at
FROM sessions
ORDER BY updated_at DESC, session_id DESC;

-- name: DeleteSession :execrows
DELETE FROM sessions
WHERE session_id = $1;

-- name: TouchSession :execrows
UPDATE sessions
SET updated_at = now()
WHERE session_id = $1;

-- name: CreateEvent :one
INSERT INTO session_events(session_id, event_id, event_ts, event_payload)
VALUES ($1, $2, $3, $4)
RETURNING seq, event_id, event_ts, event_payload;

-- name: CreateEventNow :one
INSERT INTO session_events(session_id, event_id, event_payload)
VALUES ($1, $2, $3)
RETURNING seq, event_id, event_ts, event_payload;

-- name: ListEvents :many
SELECT seq, event_id, event_ts, event_payload
FROM session_events
WHERE session_id = $1
ORDER BY seq ASC;

-- name: ListEventsAfter :many
SELECT seq, event_id, event_ts, event_payload
FROM session_events
WHERE session_id = $1
  AND event_ts >= $2
ORDER BY seq ASC;

-- name: ListRecentEvents :many
SELECT seq, event_id, event_ts, event_payload
FROM session_events
WHERE session_id = $1
ORDER BY seq DESC
LIMIT $2;

-- name: ListEventPage :many
SELECT seq, event_id, event_ts, event_payload
FROM session_events
WHERE session_id = $1
  AND seq < $2
ORDER BY seq DESC
LIMIT $3;

-- name: UpsertStateEntry :exec
INSERT INTO state_entries(session_id, key, value, updated_at)
VALUES ($1, $2, $3, now())
ON CONFLICT(session_id, key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = EXCLUDED.updated_at;

-- name: ListStateEntries :many
SELECT session_id, key, value, updated_at
FROM state_entries
WHERE session_id = $1
ORDER BY key ASC;

-- name: UpsertSessionSummary :exec
INSERT INTO session_summaries(session_id, filter_key, summary, updated_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT(session_id, filter_key) DO UPDATE
SET summary = EXCLUDED.summary,
    updated_at = EXCLUDED.updated_at;

-- name: ListSessionSummaries :many
SELECT session_id, filter_key, summary, updated_at
FROM session_summaries
WHERE session_id = $1
ORDER BY updated_at DESC, filter_key ASC;
