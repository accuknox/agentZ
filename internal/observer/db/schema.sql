CREATE TABLE observer_process_events(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pod_namespace TEXT NOT NULL,
  pod_name TEXT NOT NULL DEFAULT '',
  process TEXT NOT NULL,
  parent_process TEXT NOT NULL DEFAULT '',
  command_invocation TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK(action IN ('Allowed', 'Blocked')),
  source TEXT NOT NULL CHECK(source IN ('kubearmor-log', 'kubearmor-alert')),
  FOREIGN KEY(tenant_namespace, agent_name)
    REFERENCES agents(tenant_namespace, agent_name)
    ON DELETE CASCADE
);

CREATE INDEX observer_process_events_session_time_idx
  ON observer_process_events(
    tenant_namespace,
    agent_name,
    event_time DESC,
    id DESC
  );

CREATE INDEX observer_process_events_time_brin_idx
  ON observer_process_events USING BRIN(event_time);

CREATE INDEX observer_process_events_session_action_time_idx
  ON observer_process_events(
    tenant_namespace,
    agent_name,
    action,
    event_time DESC,
    id DESC
  );

CREATE INDEX observer_process_events_session_process_time_idx
  ON observer_process_events(
    tenant_namespace,
    agent_name,
    process,
    event_time DESC,
    id DESC
  );

CREATE TABLE observer_file_events(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pod_namespace TEXT NOT NULL,
  pod_name TEXT NOT NULL DEFAULT '',
  file_path_accessed TEXT NOT NULL,
  process TEXT NOT NULL,
  command_invocation TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK(action IN ('Allowed', 'Blocked')),
  source TEXT NOT NULL CHECK(source IN ('kubearmor-log', 'kubearmor-alert')),
  FOREIGN KEY(tenant_namespace, agent_name)
    REFERENCES agents(tenant_namespace, agent_name)
    ON DELETE CASCADE
);

CREATE INDEX observer_file_events_session_time_idx
  ON observer_file_events(
    tenant_namespace,
    agent_name,
    event_time DESC,
    id DESC
  );

CREATE INDEX observer_file_events_time_brin_idx
  ON observer_file_events USING BRIN(event_time);

CREATE INDEX observer_file_events_session_action_time_idx
  ON observer_file_events(
    tenant_namespace,
    agent_name,
    action,
    event_time DESC,
    id DESC
  );

CREATE INDEX observer_file_events_session_path_time_idx
  ON observer_file_events(
    tenant_namespace,
    agent_name,
    file_path_accessed,
    event_time DESC,
    id DESC
  );

CREATE TABLE observer_network_events(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pod_namespace TEXT NOT NULL,
  pod_name TEXT NOT NULL DEFAULT '',
  destination_domain TEXT NOT NULL DEFAULT '',
  destination_ip TEXT NOT NULL DEFAULT '',
  destination_port BIGINT NOT NULL,
  protocol TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('Allowed', 'Blocked')),
  source TEXT NOT NULL CHECK(source = 'hubble'),
  FOREIGN KEY(tenant_namespace, agent_name)
    REFERENCES agents(tenant_namespace, agent_name)
    ON DELETE CASCADE
);

CREATE INDEX observer_network_events_session_time_idx
  ON observer_network_events(
    tenant_namespace,
    agent_name,
    event_time DESC,
    id DESC
  );

CREATE INDEX observer_network_events_time_brin_idx
  ON observer_network_events USING BRIN(event_time);

CREATE INDEX observer_network_events_session_action_time_idx
  ON observer_network_events(
    tenant_namespace,
    agent_name,
    action,
    event_time DESC,
    id DESC
  );

CREATE INDEX observer_network_events_session_destination_time_idx
  ON observer_network_events(
    tenant_namespace,
    agent_name,
    destination_ip,
    destination_port,
    protocol,
    event_time DESC,
    id DESC
  );

CREATE TABLE observer_traces(
  trace_id BYTEA PRIMARY KEY,
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  root_span_id BYTEA NOT NULL DEFAULT ''::BYTEA,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  duration_ns BIGINT NOT NULL,
  span_count BIGINT NOT NULL,
  error_count BIGINT NOT NULL,
  tool_count BIGINT NOT NULL,
  model_count BIGINT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  cached_write_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  status_code TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_namespace, agent_name)
    REFERENCES agents(tenant_namespace, agent_name)
    ON DELETE CASCADE
);

CREATE INDEX observer_traces_session_started_idx
  ON observer_traces(tenant_namespace, agent_name, started_at DESC);

CREATE INDEX observer_traces_session_started_trace_idx
  ON observer_traces(
    tenant_namespace,
    agent_name,
    started_at DESC,
    trace_id DESC
  );

CREATE INDEX observer_traces_started_brin_idx
  ON observer_traces USING BRIN(started_at);

CREATE TABLE observer_trace_sessions(
  trace_id BYTEA NOT NULL
    REFERENCES observer_traces(trace_id)
    ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  root_span_id BYTEA NOT NULL DEFAULT ''::BYTEA,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  duration_ns BIGINT NOT NULL,
  span_count BIGINT NOT NULL,
  error_count BIGINT NOT NULL,
  tool_count BIGINT NOT NULL,
  model_count BIGINT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  cached_write_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  status_code TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(trace_id, session_id),
  FOREIGN KEY(tenant_namespace, agent_name)
    REFERENCES agents(tenant_namespace, agent_name)
    ON DELETE CASCADE
);

CREATE INDEX observer_trace_sessions_agent_started_trace_idx
  ON observer_trace_sessions(
    tenant_namespace,
    agent_name,
    started_at DESC,
    trace_id DESC,
    session_id DESC
  );

CREATE INDEX observer_trace_sessions_agent_session_started_idx
  ON observer_trace_sessions(
    tenant_namespace,
    agent_name,
    session_id,
    started_at DESC,
    trace_id DESC
  );

CREATE INDEX observer_trace_sessions_started_brin_idx
  ON observer_trace_sessions USING BRIN(started_at);

CREATE TABLE observer_trace_spans(
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  trace_id BYTEA NOT NULL
    REFERENCES observer_traces(trace_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  span_id BYTEA NOT NULL,
  parent_span_id BYTEA NOT NULL DEFAULT ''::BYTEA,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  duration_ns BIGINT NOT NULL,
  name TEXT NOT NULL,
  span_class TEXT NOT NULL DEFAULT '',
  operation_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  status_code TEXT NOT NULL DEFAULT '',
  error_type TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  tool_name TEXT NOT NULL DEFAULT '',
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  cached_write_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  llm_finish_reason TEXT NOT NULL DEFAULT '',
  resource_attributes JSONB NOT NULL DEFAULT '{}'::JSONB,
  span_attributes JSONB NOT NULL DEFAULT '{}'::JSONB,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(id, start_time),
  UNIQUE(trace_id, span_id, start_time),
  FOREIGN KEY(tenant_namespace, agent_name)
    REFERENCES agents(tenant_namespace, agent_name)
    ON DELETE CASCADE
) PARTITION BY RANGE(start_time);

CREATE TABLE observer_trace_spans_default
  PARTITION OF observer_trace_spans DEFAULT;

CREATE INDEX observer_trace_spans_session_time_idx
  ON observer_trace_spans(
    tenant_namespace,
    agent_name,
    start_time DESC,
    id DESC
  );

CREATE INDEX observer_trace_spans_trace_time_idx
  ON observer_trace_spans(trace_id, start_time ASC);

CREATE INDEX observer_trace_spans_session_trace_span_idx
  ON observer_trace_spans(
    tenant_namespace,
    agent_name,
    trace_id,
    span_id,
    start_time ASC,
    id ASC
  );

CREATE INDEX observer_trace_spans_agent_session_time_idx
  ON observer_trace_spans(
    tenant_namespace,
    agent_name,
    session_id,
    start_time ASC,
    id ASC
  );

CREATE INDEX observer_trace_spans_trace_parent_idx
  ON observer_trace_spans(trace_id, parent_span_id);

CREATE INDEX observer_trace_spans_agent_class_time_idx
  ON observer_trace_spans(
    tenant_namespace,
    agent_name,
    span_class,
    start_time DESC,
    id DESC
  );

CREATE INDEX observer_trace_spans_time_brin_idx
  ON observer_trace_spans USING BRIN(start_time);

CREATE TABLE observer_trace_span_payloads(
  trace_id BYTEA NOT NULL,
  span_id BYTEA NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  input_messages JSONB NOT NULL DEFAULT 'null'::JSONB,
  output_messages JSONB NOT NULL DEFAULT 'null'::JSONB,
  tool_arguments JSONB NOT NULL DEFAULT 'null'::JSONB,
  tool_result JSONB NOT NULL DEFAULT 'null'::JSONB,
  PRIMARY KEY(trace_id, span_id, start_time),
  FOREIGN KEY(trace_id, span_id, start_time)
    REFERENCES observer_trace_spans(trace_id, span_id, start_time)
    ON DELETE CASCADE
) PARTITION BY RANGE(start_time);

CREATE TABLE observer_trace_span_payloads_default
  PARTITION OF observer_trace_span_payloads DEFAULT;

CREATE TABLE observer_mcp_tool_invocations(
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  trace_id BYTEA NOT NULL,
  span_id BYTEA NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  duration_ns BIGINT NOT NULL,
  mcp_connection_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  failed BOOLEAN NOT NULL DEFAULT false,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(id, start_time),
  UNIQUE(trace_id, span_id, start_time),
  FOREIGN KEY(tenant_namespace, agent_name)
    REFERENCES agents(tenant_namespace, agent_name)
    ON DELETE CASCADE
) PARTITION BY RANGE(start_time);

CREATE TABLE observer_mcp_tool_invocations_default
  PARTITION OF observer_mcp_tool_invocations DEFAULT;

CREATE INDEX observer_mcp_tool_invocations_agent_time_connection_tool_idx
  ON observer_mcp_tool_invocations(
    tenant_namespace,
    agent_name,
    start_time DESC,
    mcp_connection_name,
    tool_name
  );

CREATE INDEX observer_mcp_tool_invocations_agent_connection_tool_time_idx
  ON observer_mcp_tool_invocations(
    tenant_namespace,
    agent_name,
    mcp_connection_name,
    tool_name,
    start_time DESC
  );

CREATE INDEX observer_mcp_tool_invocations_time_brin_idx
  ON observer_mcp_tool_invocations USING BRIN(start_time);

CREATE TABLE observer_mcp_tool_last_called(
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  mcp_connection_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  last_called_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_namespace, agent_name, mcp_connection_name, tool_name),
  FOREIGN KEY(tenant_namespace, agent_name)
    REFERENCES agents(tenant_namespace, agent_name)
    ON DELETE CASCADE
);

CREATE INDEX observer_mcp_tool_last_called_agent_connection_time_idx
  ON observer_mcp_tool_last_called(
    tenant_namespace,
    agent_name,
    mcp_connection_name,
    last_called_at DESC
  );

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

CREATE TABLE observer_guardrail_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  occurred_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  sandbox_name TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  trace_id BYTEA NOT NULL CHECK (octet_length(trace_id) = 16),
  span_id BYTEA NOT NULL CHECK (octet_length(span_id) = 8),
  revision TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('request', 'response')),
  action TEXT NOT NULL CHECK (action IN ('failOpen', 'audit', 'mask', 'reject')),
  evaluation JSONB NOT NULL
);

CREATE INDEX observer_guardrail_events_scope_time_idx
  ON observer_guardrail_events (organization_id, workspace_id, occurred_at DESC, id DESC);
CREATE INDEX observer_guardrail_events_org_time_idx
  ON observer_guardrail_events (organization_id, occurred_at DESC, id DESC);
CREATE INDEX observer_guardrail_events_trace_idx
  ON observer_guardrail_events (organization_id, trace_id);
CREATE INDEX observer_guardrail_events_expiry_idx ON observer_guardrail_events (expires_at);
CREATE INDEX observer_guardrail_events_agent_time_idx
  ON observer_guardrail_events (organization_id, agent_name, occurred_at DESC, id DESC)
  WHERE agent_name <> '';
CREATE INDEX observer_guardrail_events_client_time_idx
  ON observer_guardrail_events (organization_id, client_id, occurred_at DESC, id DESC)
  WHERE client_id <> '';

CREATE TABLE observer_guardrail_requests (
  trace_id BYTEA NOT NULL CHECK (octet_length(trace_id) = 16),
  span_id BYTEA NOT NULL CHECK (octet_length(span_id) = 8),
  expires_at TIMESTAMPTZ NOT NULL,
  body JSON NOT NULL CHECK (json_typeof(body) = 'object'),
  PRIMARY KEY (trace_id, span_id)
);
CREATE INDEX observer_guardrail_requests_expiry_idx
  ON observer_guardrail_requests (expires_at);
