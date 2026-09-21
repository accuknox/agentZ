-- +goose Up
ALTER TABLE coding_operations ADD COLUMN compute_connection_id TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE coding_operations DROP COLUMN compute_connection_id;
