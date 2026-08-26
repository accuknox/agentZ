CREATE TABLE dashboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_namespace TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  name TEXT NOT NULL CHECK (
    length(name) <= 63 AND
    name ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
  ),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_namespace, workspace_id, agent_name, name),
  FOREIGN KEY (tenant_namespace, agent_name)
    REFERENCES agents(tenant_namespace, agent_name) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_name, organization_id)
    REFERENCES agent_owners(workspace_id, agent_name, organization_id) ON DELETE CASCADE
);

CREATE INDEX dashboards_workspace_created_idx
ON dashboards(tenant_namespace, workspace_id, created_at DESC, id DESC);

CREATE TABLE dashboard_widgets (
  revision UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  tenant_namespace TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  name TEXT NOT NULL CHECK (
    length(name) <= 63 AND
    name ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
  ),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN (
    'line', 'pie', 'bar', 'horizontal_grouped_bar', 'area', 'step', 'table', 'scatter', 'gauge'
  )),
  mode TEXT NOT NULL CHECK (mode IN ('temporal', 'latest')),
  width TEXT NOT NULL CHECK (width IN ('full', 'half', 'third')),
  definition JSONB NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dashboard_id, name),
  UNIQUE (dashboard_id, position),
  UNIQUE (tenant_namespace, revision)
);

CREATE INDEX dashboard_widgets_dashboard_idx
ON dashboard_widgets(tenant_namespace, dashboard_id, position);

CREATE TABLE dashboard_temporal_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_namespace TEXT NOT NULL,
  widget_revision UUID NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  UNIQUE (widget_revision, received_at, ordinal),
  FOREIGN KEY (tenant_namespace, widget_revision)
    REFERENCES dashboard_widgets(tenant_namespace, revision) ON DELETE CASCADE
);

CREATE INDEX dashboard_temporal_query_idx
ON dashboard_temporal_records(tenant_namespace, widget_revision, received_at, id);

CREATE TABLE dashboard_latest_records (
  tenant_namespace TEXT NOT NULL,
  widget_revision UUID NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  PRIMARY KEY (widget_revision, ordinal),
  FOREIGN KEY (tenant_namespace, widget_revision)
    REFERENCES dashboard_widgets(tenant_namespace, revision) ON DELETE CASCADE
);

CREATE INDEX dashboard_latest_query_idx
ON dashboard_latest_records(tenant_namespace, widget_revision, ordinal);

CREATE TABLE dashboard_tenant_usage (
  tenant_namespace TEXT PRIMARY KEY,
  temporal_records BIGINT NOT NULL DEFAULT 0 CHECK (temporal_records >= 0),
  temporal_bytes BIGINT NOT NULL DEFAULT 0 CHECK (temporal_bytes >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dashboard_agent_usage (
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  latest_bytes BIGINT NOT NULL DEFAULT 0 CHECK (latest_bytes >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_namespace, agent_name),
  FOREIGN KEY (tenant_namespace, agent_name)
    REFERENCES agents(tenant_namespace, agent_name) ON DELETE CASCADE
);

CREATE TABLE dashboard_publish_windows (
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  window_kind TEXT NOT NULL CHECK (window_kind IN ('minute', 'day')),
  window_start TIMESTAMPTZ NOT NULL,
  calls BIGINT NOT NULL DEFAULT 0 CHECK (calls >= 0),
  records BIGINT NOT NULL DEFAULT 0 CHECK (records >= 0),
  bytes BIGINT NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  PRIMARY KEY (tenant_namespace, agent_name, window_kind, window_start)
);

CREATE TABLE dashboard_query_windows (
  tenant_namespace TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  window_kind TEXT NOT NULL CHECK (window_kind IN ('minute', 'hour')),
  window_start TIMESTAMPTZ NOT NULL,
  calls BIGINT NOT NULL DEFAULT 0 CHECK (calls >= 0),
  cells BIGINT NOT NULL DEFAULT 0 CHECK (cells >= 0),
  PRIMARY KEY (tenant_namespace, subject_id, window_kind, window_start)
);

CREATE TABLE dashboard_query_leases (
  token UUID PRIMARY KEY,
  tenant_namespace TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX dashboard_query_leases_expiry_idx
ON dashboard_query_leases(tenant_namespace, expires_at);

CREATE TABLE dashboard_publish_idempotency (
  tenant_namespace TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash BYTEA NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  accepted_records INTEGER NOT NULL CHECK (accepted_records > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_namespace, agent_name, idempotency_key)
);

CREATE INDEX dashboard_publish_idempotency_expiry_idx
ON dashboard_publish_idempotency(created_at);

CREATE FUNCTION dashboard_account_deleted_data()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_temporal_records BIGINT;
  deleted_temporal_bytes BIGINT;
  deleted_latest_bytes BIGINT;
BEGIN
  SELECT
    count(temporal.id)::bigint,
    coalesce(sum(temporal.byte_size), 0)::bigint,
    coalesce((
      SELECT sum(latest.byte_size)
      FROM dashboard_widgets latest_widget
      JOIN dashboard_latest_records latest
        ON latest.widget_revision = latest_widget.revision
       AND latest.tenant_namespace = latest_widget.tenant_namespace
      WHERE latest_widget.dashboard_id = OLD.id
    ), 0)::bigint
  INTO deleted_temporal_records, deleted_temporal_bytes, deleted_latest_bytes
  FROM dashboard_widgets widget
  LEFT JOIN dashboard_temporal_records temporal
    ON temporal.widget_revision = widget.revision
   AND temporal.tenant_namespace = widget.tenant_namespace
  WHERE widget.dashboard_id = OLD.id;

  UPDATE dashboard_tenant_usage
  SET temporal_records = greatest(0, temporal_records - deleted_temporal_records),
      temporal_bytes = greatest(0, temporal_bytes - deleted_temporal_bytes),
      updated_at = now()
  WHERE tenant_namespace = OLD.tenant_namespace;

  UPDATE dashboard_agent_usage
  SET latest_bytes = greatest(0, latest_bytes - deleted_latest_bytes),
      updated_at = now()
  WHERE tenant_namespace = OLD.tenant_namespace
    AND agent_name = OLD.agent_name;

  RETURN OLD;
END;
$$;

CREATE TRIGGER dashboard_account_deleted_data
BEFORE DELETE ON dashboards
FOR EACH ROW
EXECUTE FUNCTION dashboard_account_deleted_data();
