-- +goose Up
ALTER TABLE agents ADD COLUMN automatic_check_interval_seconds INTEGER NOT NULL DEFAULT 1800
  CHECK (automatic_check_interval_seconds BETWEEN 60 AND 604800 AND automatic_check_interval_seconds % 60 = 0);
ALTER TABLE chat_sessions DROP CONSTRAINT chat_sessions_proactivity_ck,
  DROP COLUMN proactive_interval_seconds,
  ADD CONSTRAINT chat_sessions_proactivity_ck CHECK (
    (long_running AND kind = 'chat' AND parent_session_id IS NULL
      AND owner_id IS NOT NULL AND private_root_session_id = session_id AND next_check_at IS NOT NULL)
    OR (NOT long_running AND next_check_at IS NULL AND NOT proactive_paused)
  );
UPDATE chat_sessions s SET next_check_at = now() + make_interval(secs => a.automatic_check_interval_seconds)
FROM agents a JOIN workspaces w ON w.namespace = a.tenant_namespace
WHERE s.workspace_id = w.id AND s.agent_name = a.agent_name AND s.long_running AND NOT s.deleting;

-- +goose Down
ALTER TABLE chat_sessions DROP CONSTRAINT chat_sessions_proactivity_ck,
  ADD COLUMN proactive_interval_seconds INTEGER;
UPDATE chat_sessions s SET proactive_interval_seconds = COALESCE((
  SELECT a.automatic_check_interval_seconds FROM agents a
  JOIN workspaces w ON w.namespace = a.tenant_namespace
  WHERE s.workspace_id = w.id AND s.agent_name = a.agent_name
), 1800) WHERE s.long_running;
ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_proactivity_ck CHECK (
  (long_running AND kind = 'chat' AND parent_session_id IS NULL
    AND owner_id IS NOT NULL AND private_root_session_id = session_id
    AND proactive_interval_seconds IS NOT NULL AND proactive_interval_seconds >= 60 AND next_check_at IS NOT NULL)
  OR (NOT long_running AND proactive_interval_seconds IS NULL
    AND next_check_at IS NULL AND NOT proactive_paused)
);
ALTER TABLE agents DROP COLUMN automatic_check_interval_seconds;
