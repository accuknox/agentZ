-- +goose Up
ALTER TABLE observer_app_operations ADD COLUMN native BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE observer_app_operations DROP CONSTRAINT observer_app_operations_agent_kind_check;
ALTER TABLE observer_app_operations ADD CONSTRAINT observer_app_operations_agent_kind_check
  CHECK (agent_kind IN ('', 'claude', 'codex', 'github-copilot-cli'));
DROP TRIGGER observer_guard_external_agent ON observer_app_operations;
CREATE TRIGGER observer_guard_external_agent
BEFORE INSERT ON observer_app_operations
FOR EACH ROW WHEN (NEW.agent_kind <> '')
EXECUTE FUNCTION observer_guard_external_agent();

CREATE OR REPLACE VIEW observer_app_spans AS
SELECT op.id, op.organization_id, op.workspace_id, op.client_id, op.app_name, op.grant_id, op.user_id,
  op.resource_kind, op.resource_namespace, op.resource_name, op.resource_uid, op.target_id,
  COALESCE(run.trace_id, op.trace_id)::bytea AS trace_id, op.span_id,
  CASE WHEN op.native THEN op.parent_span_id
    WHEN op.resource_kind = 'turn' THEN ''::bytea
    ELSE COALESCE(run.span_id, op.parent_span_id) END::bytea AS parent_span_id,
  op.start_time, op.end_time, op.duration_ns, op.name, op.span_class, op.operation_name,
  CASE WHEN op.native OR op.resource_kind <> 'tool' THEN op.status_code
    WHEN result.is_error THEN 'ERROR' WHEN result.id IS NOT NULL THEN 'OK' ELSE 'UNSET' END::text AS status_code,
  op.error_type, op.error_message, op.model, op.tool_name,
  COALESCE(NULLIF(op.session_id, ''), run.session_id, '')::text AS session_id,
  op.input_tokens, op.output_tokens, op.reasoning_tokens, op.cached_input_tokens, op.cached_write_tokens, op.cost_usd,
  op.ingested_at, op.agent_kind, COALESCE(NULLIF(op.turn_id, ''), run.turn_id, '')::text AS turn_id,
  op.tool_call_id, op.run_id, op.source_operation_id, op.result_id,
  ((op.agent_kind <> 'github-copilot-cli' OR op.native) AND (op.resource_kind <> 'tool' OR NOT EXISTS (
    SELECT 1 FROM observer_app_operations mcp
    WHERE mcp.organization_id = op.organization_id AND mcp.workspace_id = op.workspace_id
      AND mcp.client_id = op.client_id AND mcp.user_id = op.user_id
      AND mcp.resource_kind = 'mcp' AND mcp.tool_call_id = op.tool_call_id AND mcp.run_id = op.run_id
      AND mcp.agent_kind = op.agent_kind
  ))) AS visible, op.native
FROM observer_app_operations op
LEFT JOIN observer_app_operations run ON run.id = op.run_id
LEFT JOIN observer_app_tool_results result ON result.id = op.result_id;

-- +goose Down
-- Refuse rollback while Copilot audit records exist.
ALTER TABLE observer_app_operations DROP CONSTRAINT observer_app_operations_agent_kind_check;
ALTER TABLE observer_app_operations ADD CONSTRAINT observer_app_operations_agent_kind_check
  CHECK (agent_kind IN ('', 'claude', 'codex'));
DROP VIEW observer_app_spans;
CREATE VIEW observer_app_spans AS
SELECT op.id, op.organization_id, op.workspace_id, op.client_id, op.app_name, op.grant_id, op.user_id,
  op.resource_kind, op.resource_namespace, op.resource_name, op.resource_uid, op.target_id,
  COALESCE(run.trace_id, op.trace_id)::bytea AS trace_id, op.span_id,
  CASE WHEN op.resource_kind = 'turn' THEN ''::bytea
    ELSE COALESCE(run.span_id, op.parent_span_id) END::bytea AS parent_span_id,
  op.start_time, op.end_time, op.duration_ns, op.name, op.span_class, op.operation_name,
  CASE WHEN op.resource_kind <> 'tool' THEN op.status_code
    WHEN result.is_error THEN 'ERROR' WHEN result.id IS NOT NULL THEN 'OK' ELSE 'UNSET' END::text AS status_code,
  op.error_type, op.error_message, op.model, op.tool_name,
  COALESCE(NULLIF(op.session_id, ''), run.session_id, '')::text AS session_id,
  op.input_tokens, op.output_tokens, op.reasoning_tokens, op.cached_input_tokens, op.cached_write_tokens, op.cost_usd,
  op.ingested_at, op.agent_kind, COALESCE(NULLIF(op.turn_id, ''), run.turn_id, '')::text AS turn_id,
  op.tool_call_id, op.run_id, op.source_operation_id, op.result_id,
  (op.resource_kind <> 'tool' OR NOT EXISTS (
    SELECT 1 FROM observer_app_operations mcp
    WHERE mcp.organization_id = op.organization_id AND mcp.workspace_id = op.workspace_id
      AND mcp.client_id = op.client_id AND mcp.user_id = op.user_id
      AND mcp.resource_kind = 'mcp' AND mcp.tool_call_id = op.tool_call_id AND mcp.run_id = op.run_id
      AND mcp.agent_kind = op.agent_kind
  )) AS visible
FROM observer_app_operations op
LEFT JOIN observer_app_operations run ON run.id = op.run_id
LEFT JOIN observer_app_tool_results result ON result.id = op.result_id;
ALTER TABLE observer_app_operations DROP COLUMN native;
