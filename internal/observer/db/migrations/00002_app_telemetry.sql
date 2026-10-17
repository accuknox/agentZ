-- +goose Up

CREATE TABLE observer_app_operations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  app_name TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_namespace TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  target_id TEXT NOT NULL,
  trace_id BYTEA NOT NULL,
  span_id BYTEA NOT NULL,
  parent_span_id BYTEA NOT NULL DEFAULT ''::BYTEA,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  duration_ns BIGINT NOT NULL,
  name TEXT NOT NULL,
  span_class TEXT NOT NULL,
  operation_name TEXT NOT NULL,
  status_code TEXT NOT NULL,
  error_type TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  tool_name TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  agent_kind TEXT NOT NULL DEFAULT '' CHECK (agent_kind IN ('', 'claude', 'codex')),
  turn_id TEXT NOT NULL DEFAULT '',
  tool_call_id TEXT NOT NULL DEFAULT '',
  run_id BIGINT REFERENCES observer_app_operations(id) ON DELETE SET NULL,
  source_operation_id BIGINT REFERENCES observer_app_operations(id) ON DELETE SET NULL,
  result_id BIGINT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  reasoning_tokens BIGINT,
  cached_input_tokens BIGINT,
  cached_write_tokens BIGINT,
  cost_usd DOUBLE PRECISION,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, workspace_id, client_id, trace_id, span_id, start_time)
);

CREATE INDEX observer_app_operations_subject_time_idx
  ON observer_app_operations (organization_id, workspace_id, client_id, start_time DESC, id DESC);
CREATE INDEX observer_app_operations_subject_trace_idx
  ON observer_app_operations (organization_id, workspace_id, client_id, trace_id, start_time, id);

CREATE TABLE observer_app_operation_payloads (
  operation_id BIGINT PRIMARY KEY REFERENCES observer_app_operations(id) ON DELETE CASCADE,
  input_messages JSONB NOT NULL DEFAULT 'null'::JSONB,
  output_messages JSONB NOT NULL DEFAULT 'null'::JSONB,
  tool_arguments JSONB NOT NULL DEFAULT 'null'::JSONB,
  tool_result JSONB NOT NULL DEFAULT 'null'::JSONB,
  tool_error JSONB NOT NULL DEFAULT 'null'::JSONB
);

CREATE UNIQUE INDEX observer_app_operations_turn_idx
  ON observer_app_operations (organization_id, workspace_id, client_id, user_id, session_id, turn_id)
  WHERE resource_kind = 'turn';
CREATE UNIQUE INDEX observer_app_operations_tool_idx
  ON observer_app_operations (organization_id, workspace_id, client_id, user_id, session_id, turn_id, tool_call_id)
  WHERE resource_kind = 'tool' AND session_id <> '' AND turn_id <> '';
-- Without a native turn, a call ID identifies an occurrence only within the
-- emitting response. Independent app requests may reuse the same call ID.
CREATE UNIQUE INDEX observer_app_operations_source_tool_idx
  ON observer_app_operations (source_operation_id, tool_call_id)
  WHERE resource_kind = 'tool' AND (session_id = '' OR turn_id = '');
CREATE INDEX observer_app_operations_call_idx
  ON observer_app_operations (organization_id, workspace_id, client_id, user_id, tool_call_id)
  WHERE tool_call_id <> '';
CREATE INDEX observer_app_operations_run_idx
  ON observer_app_operations (organization_id, workspace_id, client_id, run_id, start_time, id);
CREATE INDEX observer_app_operations_roots_idx
  ON observer_app_operations (organization_id, workspace_id, client_id, resource_kind, start_time DESC, trace_id DESC)
  INCLUDE (id, session_id, end_time) WHERE run_id IS NULL;
CREATE INDEX observer_app_operations_source_idx
  ON observer_app_operations (source_operation_id) WHERE source_operation_id IS NOT NULL;
CREATE INDEX observer_app_operations_session_idx
  ON observer_app_operations (organization_id, workspace_id, client_id, session_id, start_time DESC, id DESC)
  WHERE session_id <> '';

-- Results reference the existing request payload. Replayed history adds only
-- source positions, preserving conflicting evidence without copying tool bodies.
CREATE TABLE observer_app_tool_results (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  source_operation_id BIGINT NOT NULL REFERENCES observer_app_operations(id) ON DELETE CASCADE,
  source_start_time TIMESTAMPTZ NOT NULL,
  source_ordinal BIGINT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('messages', 'responses', 'chat')),
  is_error BOOLEAN NOT NULL,
  UNIQUE (source_operation_id, protocol, source_ordinal)
);
CREATE INDEX observer_app_tool_results_call_idx
  ON observer_app_tool_results (organization_id, workspace_id, client_id, user_id, tool_call_id, session_id);
ALTER TABLE observer_app_operations ADD CONSTRAINT observer_app_operations_result_fk
  FOREIGN KEY (result_id) REFERENCES observer_app_tool_results(id) ON DELETE SET NULL;

-- This projection keeps transport IDs on observations and exposes logical
-- parentage without reparsing payloads or raw telemetry attribute bags.
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

-- +goose Down
DROP VIEW observer_app_spans;
DROP TABLE observer_app_operation_payloads;
ALTER TABLE observer_app_operations DROP CONSTRAINT observer_app_operations_result_fk;
DROP TABLE observer_app_tool_results;
DROP TABLE observer_app_operations;
