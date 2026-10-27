-- +goose Up
-- One request can produce several evaluations. Keep its captured body once,
-- separate from metadata that guardrail-event readers can access without Lens.
CREATE TABLE observer_guardrail_requests (
  trace_id BYTEA NOT NULL CHECK (octet_length(trace_id) = 16),
  span_id BYTEA NOT NULL CHECK (octet_length(span_id) = 8),
  expires_at TIMESTAMPTZ NOT NULL,
  body JSONB NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  PRIMARY KEY (trace_id, span_id)
);
CREATE INDEX observer_guardrail_requests_expiry_idx
  ON observer_guardrail_requests (expires_at);

-- +goose Down
DROP TABLE observer_guardrail_requests;
