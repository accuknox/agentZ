CREATE TABLE observer_process_events(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_name TEXT NOT NULL REFERENCES agents(agent_name) ON DELETE CASCADE,
  event_time TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pod_namespace TEXT NOT NULL,
  pod_name TEXT NOT NULL DEFAULT '',
  process TEXT NOT NULL,
  parent_process TEXT NOT NULL DEFAULT '',
  command_invocation TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK(action IN ('Allowed', 'Blocked')),
  source TEXT NOT NULL CHECK(source IN ('kubearmor-log', 'kubearmor-alert'))
);

CREATE INDEX observer_process_events_session_time_idx
  ON observer_process_events(agent_name, event_time DESC, id DESC);

CREATE INDEX observer_process_events_time_brin_idx
  ON observer_process_events USING BRIN(event_time);

CREATE INDEX observer_process_events_session_action_time_idx
  ON observer_process_events(agent_name, action, event_time DESC, id DESC);

CREATE INDEX observer_process_events_session_process_time_idx
  ON observer_process_events(agent_name, process, event_time DESC, id DESC);

CREATE TABLE observer_file_events(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_name TEXT NOT NULL REFERENCES agents(agent_name) ON DELETE CASCADE,
  event_time TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pod_namespace TEXT NOT NULL,
  pod_name TEXT NOT NULL DEFAULT '',
  file_path_accessed TEXT NOT NULL,
  process TEXT NOT NULL,
  command_invocation TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK(action IN ('Allowed', 'Blocked')),
  source TEXT NOT NULL CHECK(source IN ('kubearmor-log', 'kubearmor-alert'))
);

CREATE INDEX observer_file_events_session_time_idx
  ON observer_file_events(agent_name, event_time DESC, id DESC);

CREATE INDEX observer_file_events_time_brin_idx
  ON observer_file_events USING BRIN(event_time);

CREATE INDEX observer_file_events_session_action_time_idx
  ON observer_file_events(agent_name, action, event_time DESC, id DESC);

CREATE INDEX observer_file_events_session_path_time_idx
  ON observer_file_events(agent_name, file_path_accessed, event_time DESC, id DESC);

CREATE TABLE observer_network_events(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_name TEXT NOT NULL REFERENCES agents(agent_name) ON DELETE CASCADE,
  event_time TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pod_namespace TEXT NOT NULL,
  pod_name TEXT NOT NULL DEFAULT '',
  destination_domain TEXT NOT NULL DEFAULT '',
  destination_ip TEXT NOT NULL DEFAULT '',
  destination_port BIGINT NOT NULL,
  protocol TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('Allowed', 'Blocked')),
  source TEXT NOT NULL CHECK(source = 'hubble')
);

CREATE INDEX observer_network_events_session_time_idx
  ON observer_network_events(agent_name, event_time DESC, id DESC);

CREATE INDEX observer_network_events_time_brin_idx
  ON observer_network_events USING BRIN(event_time);

CREATE INDEX observer_network_events_session_action_time_idx
  ON observer_network_events(agent_name, action, event_time DESC, id DESC);

CREATE INDEX observer_network_events_session_destination_time_idx
  ON observer_network_events(
    agent_name,
    destination_ip,
    destination_port,
    protocol,
    event_time DESC,
    id DESC
  );

CREATE TABLE observer_traces(
  trace_id BYTEA PRIMARY KEY,
  agent_name TEXT NOT NULL REFERENCES agents(agent_name) ON DELETE CASCADE,
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX observer_traces_session_started_idx
  ON observer_traces(agent_name, started_at DESC);

CREATE INDEX observer_traces_session_started_trace_idx
  ON observer_traces(agent_name, started_at DESC, trace_id DESC);

CREATE INDEX observer_traces_started_brin_idx
  ON observer_traces USING BRIN(started_at);

CREATE TABLE observer_trace_sessions(
  trace_id BYTEA NOT NULL
    REFERENCES observer_traces(trace_id)
    ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  agent_name TEXT NOT NULL REFERENCES agents(agent_name) ON DELETE CASCADE,
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
  PRIMARY KEY(trace_id, session_id)
);

CREATE INDEX observer_trace_sessions_agent_started_trace_idx
  ON observer_trace_sessions(agent_name, started_at DESC, trace_id DESC, session_id DESC);

CREATE INDEX observer_trace_sessions_agent_session_started_idx
  ON observer_trace_sessions(agent_name, session_id, started_at DESC, trace_id DESC);

CREATE INDEX observer_trace_sessions_started_brin_idx
  ON observer_trace_sessions USING BRIN(started_at);

CREATE TABLE observer_trace_spans(
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  agent_name TEXT NOT NULL REFERENCES agents(agent_name) ON DELETE CASCADE,
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
  UNIQUE(trace_id, span_id, start_time)
) PARTITION BY RANGE(start_time);

CREATE TABLE observer_trace_spans_default
  PARTITION OF observer_trace_spans DEFAULT;

CREATE INDEX observer_trace_spans_session_time_idx
  ON observer_trace_spans(agent_name, start_time DESC, id DESC);

CREATE INDEX observer_trace_spans_trace_time_idx
  ON observer_trace_spans(trace_id, start_time ASC);

CREATE INDEX observer_trace_spans_session_trace_span_idx
  ON observer_trace_spans(agent_name, trace_id, span_id, start_time ASC, id ASC);

CREATE INDEX observer_trace_spans_agent_session_time_idx
  ON observer_trace_spans(agent_name, session_id, start_time ASC, id ASC);

CREATE INDEX observer_trace_spans_trace_parent_idx
  ON observer_trace_spans(trace_id, parent_span_id);

CREATE INDEX observer_trace_spans_agent_class_time_idx
  ON observer_trace_spans(agent_name, span_class, start_time DESC, id DESC);

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
  agent_name TEXT NOT NULL REFERENCES agents(agent_name) ON DELETE CASCADE,
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
  UNIQUE(trace_id, span_id, start_time)
) PARTITION BY RANGE(start_time);

CREATE TABLE observer_mcp_tool_invocations_default
  PARTITION OF observer_mcp_tool_invocations DEFAULT;

CREATE INDEX observer_mcp_tool_invocations_agent_time_connection_tool_idx
  ON observer_mcp_tool_invocations(
    agent_name,
    start_time DESC,
    mcp_connection_name,
    tool_name
  );

CREATE INDEX observer_mcp_tool_invocations_agent_connection_tool_time_idx
  ON observer_mcp_tool_invocations(
    agent_name,
    mcp_connection_name,
    tool_name,
    start_time DESC
  );

CREATE INDEX observer_mcp_tool_invocations_time_brin_idx
  ON observer_mcp_tool_invocations USING BRIN(start_time);

CREATE TABLE observer_mcp_tool_last_called(
  agent_name TEXT NOT NULL REFERENCES agents(agent_name) ON DELETE CASCADE,
  mcp_connection_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  last_called_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(agent_name, mcp_connection_name, tool_name)
);

CREATE INDEX observer_mcp_tool_last_called_agent_connection_time_idx
  ON observer_mcp_tool_last_called(
    agent_name,
    mcp_connection_name,
    last_called_at DESC
  );
