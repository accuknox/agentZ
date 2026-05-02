-- +goose Up
CREATE INDEX observer_traces_session_started_trace_idx
  ON observer_traces(session_id, started_at DESC, trace_id DESC);

-- +goose Down
DROP INDEX observer_traces_session_started_trace_idx;
