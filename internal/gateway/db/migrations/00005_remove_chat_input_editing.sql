-- +goose Up
-- Keep held messages as private drafts instead of sending their stale content.
UPDATE chat_inputs SET state = 'recovered', resume = false,
  revision = revision + 1, updated_at = now()
WHERE state = 'editing';

ALTER TABLE chat_inputs DROP CONSTRAINT chat_inputs_state_check;
ALTER TABLE chat_inputs ADD CONSTRAINT chat_inputs_state_check
  CHECK (state IN ('queued', 'sending', 'delivered', 'failed', 'recovered', 'removed'));
ALTER TABLE chat_inputs DROP COLUMN edit_state;

-- +goose Down
ALTER TABLE chat_inputs ADD COLUMN edit_state TEXT NOT NULL DEFAULT '';
ALTER TABLE chat_inputs DROP CONSTRAINT chat_inputs_state_check;
ALTER TABLE chat_inputs ADD CONSTRAINT chat_inputs_state_check
  CHECK (state IN ('queued', 'editing', 'sending', 'delivered', 'failed', 'recovered', 'removed'));
