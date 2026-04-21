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
