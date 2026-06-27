CREATE TABLE apikeys(
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL DEFAULT 'default',
  name TEXT,
  start TEXT,
  reference_id TEXT NOT NULL,
  prefix TEXT,
  key TEXT NOT NULL,
  refill_interval BIGINT,
  refill_amount BIGINT,
  last_refill_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT true,
  rate_limit_enabled BOOLEAN NOT NULL DEFAULT true,
  rate_limit_time_window BIGINT,
  rate_limit_max BIGINT,
  request_count BIGINT NOT NULL DEFAULT 0,
  remaining BIGINT,
  last_request TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  permissions TEXT,
  metadata TEXT
);

CREATE INDEX apikeys_key_idx ON apikeys(key);
CREATE INDEX apikeys_config_id_idx ON apikeys(config_id);
CREATE INDEX apikeys_reference_id_idx ON apikeys(reference_id);
