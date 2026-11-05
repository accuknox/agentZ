-- +goose Up
ALTER TABLE chat_sessions
  ADD COLUMN pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN locked boolean NOT NULL DEFAULT false,
  ADD COLUMN state_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN state_changed_by text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN state_changed_at timestamptz;

-- +goose Down
ALTER TABLE chat_sessions DROP COLUMN pinned, DROP COLUMN locked, DROP COLUMN state_version, DROP COLUMN state_changed_by, DROP COLUMN state_changed_at;
