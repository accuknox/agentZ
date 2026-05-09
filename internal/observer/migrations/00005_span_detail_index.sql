-- +goose Up
CREATE INDEX observer_trace_spans_session_trace_span_idx
  ON observer_trace_spans(agent_name, trace_id, span_id, start_time ASC, id ASC);

-- +goose Down
DROP INDEX observer_trace_spans_session_trace_span_idx;
