-- +goose Up
ALTER TABLE sessions
  ADD COLUMN agent_name TEXT;

UPDATE sessions
SET agent_name = 'legacy-' || substr(md5(session_id::TEXT), 1, 24)
WHERE agent_name IS NULL;

ALTER TABLE sessions
  ALTER COLUMN agent_name SET NOT NULL,
  ADD CONSTRAINT sessions_agent_name_key UNIQUE(agent_name),
  ADD CONSTRAINT sessions_agent_name_dns_check CHECK (
    length(agent_name) <= 32 AND
    agent_name ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
  );

-- +goose Down
ALTER TABLE sessions
  DROP CONSTRAINT sessions_agent_name_dns_check,
  DROP CONSTRAINT sessions_agent_name_key,
  DROP COLUMN agent_name;
