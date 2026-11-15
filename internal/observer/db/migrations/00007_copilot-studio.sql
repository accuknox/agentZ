-- +goose Up
ALTER TABLE observer_app_operations DROP CONSTRAINT observer_app_operations_agent_kind_check;
ALTER TABLE observer_app_operations ADD CONSTRAINT observer_app_operations_agent_kind_check
CHECK (agent_kind IN ('', 'claude', 'codex', 'github-copilot-cli', 'github-copilot-desktop', 'chatgpt-desktop', 'claude-desktop', 'microsoft-copilot-studio'));

ALTER TABLE observer_app_operations ADD COLUMN external_tool_id TEXT NOT NULL DEFAULT '';
CREATE INDEX observer_app_operations_copilot_tool_idx
  ON observer_app_operations (organization_id, workspace_id, client_id, user_id, session_id, external_tool_id)
  WHERE native AND agent_kind = 'microsoft-copilot-studio' AND resource_kind = 'tool';

-- +goose Down
DROP INDEX observer_app_operations_copilot_tool_idx;
ALTER TABLE observer_app_operations DROP COLUMN external_tool_id;
ALTER TABLE observer_app_operations DROP CONSTRAINT observer_app_operations_agent_kind_check;
ALTER TABLE observer_app_operations ADD CONSTRAINT observer_app_operations_agent_kind_check
CHECK (agent_kind IN ('', 'claude', 'codex', 'github-copilot-cli', 'github-copilot-desktop', 'chatgpt-desktop', 'claude-desktop'));
