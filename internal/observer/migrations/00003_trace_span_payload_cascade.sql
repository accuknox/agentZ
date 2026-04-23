-- +goose Up
DELETE FROM observer_trace_span_payloads payload
WHERE NOT EXISTS (
  SELECT 1
  FROM observer_trace_spans span
  WHERE span.trace_id = payload.trace_id
    AND span.span_id = payload.span_id
    AND span.start_time = payload.start_time
);

ALTER TABLE observer_trace_span_payloads
  ADD CONSTRAINT observer_trace_span_payloads_span_fkey
  FOREIGN KEY(trace_id, span_id, start_time)
  REFERENCES observer_trace_spans(trace_id, span_id, start_time)
  ON DELETE CASCADE;

-- +goose Down
ALTER TABLE observer_trace_span_payloads
  DROP CONSTRAINT observer_trace_span_payloads_span_fkey;
