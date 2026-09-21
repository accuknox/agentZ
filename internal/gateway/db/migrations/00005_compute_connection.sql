-- +goose Up
ALTER TABLE chat_inputs ADD COLUMN compute_connection_id TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE chat_inputs DROP COLUMN compute_connection_id;
