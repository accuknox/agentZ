CREATE TABLE observer_process_events(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
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
  ON observer_process_events(session_id, event_time DESC, id DESC);

CREATE INDEX observer_process_events_time_brin_idx
  ON observer_process_events USING BRIN(event_time);

CREATE INDEX observer_process_events_session_action_time_idx
  ON observer_process_events(session_id, action, event_time DESC, id DESC);

CREATE INDEX observer_process_events_session_process_time_idx
  ON observer_process_events(session_id, process, event_time DESC, id DESC);

CREATE TABLE observer_file_events(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
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
  ON observer_file_events(session_id, event_time DESC, id DESC);

CREATE INDEX observer_file_events_time_brin_idx
  ON observer_file_events USING BRIN(event_time);

CREATE INDEX observer_file_events_session_action_time_idx
  ON observer_file_events(session_id, action, event_time DESC, id DESC);

CREATE INDEX observer_file_events_session_path_time_idx
  ON observer_file_events(session_id, file_path_accessed, event_time DESC, id DESC);

CREATE TABLE observer_network_events(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
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
  ON observer_network_events(session_id, event_time DESC, id DESC);

CREATE INDEX observer_network_events_time_brin_idx
  ON observer_network_events USING BRIN(event_time);

CREATE INDEX observer_network_events_session_action_time_idx
  ON observer_network_events(session_id, action, event_time DESC, id DESC);

CREATE INDEX observer_network_events_session_destination_time_idx
  ON observer_network_events(
    session_id,
    destination_ip,
    destination_port,
    protocol,
    event_time DESC,
    id DESC
  );

CREATE TABLE observer_traces(
  trace_id BYTEA PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  root_span_id BYTEA NOT NULL DEFAULT ''::BYTEA,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  duration_ns BIGINT NOT NULL,
  span_count BIGINT NOT NULL,
  error_count BIGINT NOT NULL,
  tool_count BIGINT NOT NULL,
  model_count BIGINT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  status_code TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX observer_traces_session_started_idx
  ON observer_traces(session_id, started_at DESC);

CREATE INDEX observer_traces_started_brin_idx
  ON observer_traces USING BRIN(started_at);

CREATE TABLE observer_trace_spans(
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  trace_id BYTEA NOT NULL,
  span_id BYTEA NOT NULL,
  parent_span_id BYTEA NOT NULL DEFAULT ''::BYTEA,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  duration_ns BIGINT NOT NULL,
  name TEXT NOT NULL,
  operation_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  status_code TEXT NOT NULL DEFAULT '',
  error_type TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  tool_name TEXT NOT NULL DEFAULT '',
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  time_to_first_token_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  pod_namespace TEXT NOT NULL DEFAULT '',
  pod_name TEXT NOT NULL DEFAULT '',
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(id, start_time),
  UNIQUE(trace_id, span_id, start_time)
) PARTITION BY RANGE(start_time);

CREATE TABLE observer_trace_spans_default
  PARTITION OF observer_trace_spans DEFAULT;

CREATE INDEX observer_trace_spans_session_time_idx
  ON observer_trace_spans(session_id, start_time DESC, id DESC);

CREATE INDEX observer_trace_spans_trace_time_idx
  ON observer_trace_spans(trace_id, start_time ASC);

CREATE INDEX observer_trace_spans_trace_parent_idx
  ON observer_trace_spans(trace_id, parent_span_id);

CREATE INDEX observer_trace_spans_session_pod_time_idx
  ON observer_trace_spans(session_id, pod_namespace, pod_name, start_time DESC);

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
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  PRIMARY KEY(trace_id, span_id, start_time),
  FOREIGN KEY(trace_id, span_id, start_time)
    REFERENCES observer_trace_spans(trace_id, span_id, start_time)
    ON DELETE CASCADE
) PARTITION BY RANGE(start_time);

CREATE TABLE observer_trace_span_payloads_default
  PARTITION OF observer_trace_span_payloads DEFAULT;
