-- +goose Up
CREATE TABLE agents(
  agent_name TEXT PRIMARY KEY
    CHECK (
      length(agent_name) <= 32 AND
      agent_name ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
    ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE agents;
