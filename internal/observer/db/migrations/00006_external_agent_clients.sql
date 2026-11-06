-- +goose Up
ALTER TABLE observer_app_operations DROP CONSTRAINT observer_app_operations_agent_kind_check;
ALTER TABLE observer_app_operations ADD CONSTRAINT observer_app_operations_agent_kind_check
  CHECK (agent_kind IN ('', 'claude', 'codex', 'chatgpt-desktop', 'claude-desktop', 'github-copilot-cli', 'github-copilot-desktop'));

DROP TRIGGER observer_guard_external_agent ON observer_app_operations;
CREATE TRIGGER observer_guard_external_agent
BEFORE INSERT ON observer_app_operations
FOR EACH ROW WHEN (NEW.agent_kind <> '')
EXECUTE FUNCTION observer_guard_external_agent();

-- +goose Down
-- Refuse rollback while new client telemetry exists; silently deleting audit
-- history during a rollback would break retention and deletion guarantees.
DROP TRIGGER observer_guard_external_agent ON observer_app_operations;
CREATE TRIGGER observer_guard_external_agent
BEFORE INSERT ON observer_app_operations
FOR EACH ROW WHEN (NEW.agent_kind IN ('claude', 'codex'))
EXECUTE FUNCTION observer_guard_external_agent();
ALTER TABLE observer_app_operations DROP CONSTRAINT observer_app_operations_agent_kind_check;
ALTER TABLE observer_app_operations ADD CONSTRAINT observer_app_operations_agent_kind_check
  CHECK (agent_kind IN ('', 'claude', 'codex'));
