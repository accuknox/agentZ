-- +goose Up
ALTER TABLE observer_app_operations DROP CONSTRAINT observer_app_operations_agent_kind_check;
ALTER TABLE observer_app_operations ADD CONSTRAINT observer_app_operations_agent_kind_check
CHECK (agent_kind IN ('', 'claude', 'codex', 'github-copilot-cli', 'github-copilot-desktop', 'chatgpt-desktop', 'claude-desktop', 'microsoft-copilot-studio'));

-- +goose Down
ALTER TABLE observer_app_operations DROP CONSTRAINT observer_app_operations_agent_kind_check;
ALTER TABLE observer_app_operations ADD CONSTRAINT observer_app_operations_agent_kind_check
CHECK (agent_kind IN ('', 'claude', 'codex', 'github-copilot-cli', 'github-copilot-desktop', 'chatgpt-desktop', 'claude-desktop'));
