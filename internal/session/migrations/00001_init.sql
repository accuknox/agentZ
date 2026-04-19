-- +goose Up
CREATE TABLE sessions(
  session_id UUID PRIMARY KEY
    CHECK (
      session_id::TEXT ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE session_events(
  seq BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_payload JSONB NOT NULL
);

CREATE UNIQUE INDEX session_events_session_event_id_idx
  ON session_events(session_id, event_id);

CREATE INDEX session_events_session_seq_idx
  ON session_events(session_id, seq);

CREATE INDEX session_events_session_ts_idx
  ON session_events(session_id, event_ts, seq);

CREATE TABLE state_entries(
  session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id, key)
);

CREATE TABLE session_summaries(
  session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  filter_key TEXT NOT NULL,
  summary JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(session_id, filter_key)
);

CREATE INDEX session_summaries_session_updated_idx
  ON session_summaries(session_id, updated_at DESC, filter_key ASC);

-- +goose Down
DROP INDEX session_summaries_session_updated_idx;
DROP TABLE session_summaries;
DROP TABLE state_entries;
DROP INDEX session_events_session_ts_idx;
DROP INDEX session_events_session_seq_idx;
DROP INDEX session_events_session_event_id_idx;
DROP TABLE session_events;
DROP TABLE sessions;
