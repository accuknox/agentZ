-- +goose Up
ALTER TABLE workflow_run_evaluations
  ADD COLUMN delete_requested BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX workflow_run_evaluations_deleting
  ON workflow_run_evaluations (lease_until) WHERE delete_requested;

-- +goose Down
DROP INDEX workflow_run_evaluations_deleting;
ALTER TABLE workflow_run_evaluations DROP COLUMN delete_requested;
