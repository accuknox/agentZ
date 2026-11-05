-- +goose Up
ALTER TABLE workflows ADD COLUMN lock_state JSONB NOT NULL DEFAULT '{"locked":false,"version":0}'
  CHECK (jsonb_typeof(lock_state) = 'object');

-- +goose Down
ALTER TABLE workflows DROP COLUMN lock_state;
