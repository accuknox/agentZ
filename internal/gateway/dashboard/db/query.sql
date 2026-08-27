-- name: DashboardCountForAgent :one
SELECT count(*)
FROM dashboards
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name);

-- name: DashboardLockAgent :one
SELECT agent_name
FROM agents
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
FOR UPDATE;

-- name: DashboardCreate :one
INSERT INTO dashboards (
  tenant_namespace, organization_id, workspace_id, agent_name, name, title
) VALUES (
  sqlc.arg(tenant_namespace), sqlc.arg(organization_id), sqlc.arg(workspace_id),
  sqlc.arg(agent_name), sqlc.arg(name), sqlc.arg(title)
)
RETURNING *;

-- name: DashboardCreateWidgets :exec
INSERT INTO dashboard_widgets (
  dashboard_id, tenant_namespace, position, name, title, kind, mode, width, definition
)
SELECT
  sqlc.arg(dashboard_id), sqlc.arg(tenant_namespace), input.position, input.name,
  input.title, input.kind, input.mode, input.width, input.definition
FROM jsonb_to_recordset(sqlc.arg(widgets)::jsonb) AS input(
  position integer,
  name text,
  title text,
  kind text,
  mode text,
  width text,
  definition jsonb
);

-- name: DashboardGet :one
SELECT *
FROM dashboards
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name)
  AND name = sqlc.arg(name);

-- name: DashboardList :many
SELECT
  d.id,
  d.agent_name,
  d.name,
  d.title,
  d.created_at,
  count(w.revision)::integer AS widget_count
FROM dashboards d
LEFT JOIN dashboard_widgets w
  ON w.dashboard_id = d.id
 AND w.tenant_namespace = d.tenant_namespace
WHERE d.tenant_namespace = sqlc.arg(tenant_namespace)
  AND d.workspace_id = sqlc.arg(workspace_id)
  AND (
    sqlc.narg(agent_name)::text IS NULL OR
    d.agent_name = sqlc.narg(agent_name)::text
  )
  AND (
    cardinality(sqlc.arg(agent_names)::text[]) = 0 OR
    d.agent_name = ANY(sqlc.arg(agent_names)::text[])
  )
  AND (
    sqlc.narg(cursor_created_at)::timestamptz IS NULL OR
    (d.created_at, d.id) < (
      sqlc.narg(cursor_created_at)::timestamptz,
      sqlc.narg(cursor_id)::uuid
    )
  )
GROUP BY d.id
ORDER BY d.created_at DESC, d.id DESC
LIMIT sqlc.arg(page_size);

-- name: DashboardListWidgets :many
SELECT *
FROM dashboard_widgets
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND dashboard_id = sqlc.arg(dashboard_id)
ORDER BY position;

-- name: DashboardGetWidget :one
SELECT
  w.*,
  d.workspace_id,
  d.organization_id,
  d.agent_name,
  d.name AS dashboard_name
FROM dashboard_widgets w
JOIN dashboards d
  ON d.id = w.dashboard_id
 AND d.tenant_namespace = w.tenant_namespace
WHERE w.tenant_namespace = sqlc.arg(tenant_namespace)
  AND d.workspace_id = sqlc.arg(workspace_id)
  AND d.agent_name = sqlc.arg(agent_name)
  AND d.name = sqlc.arg(dashboard_name)
  AND w.name = sqlc.arg(widget_name);

-- name: DashboardLockWidget :one
SELECT
  w.*,
  d.workspace_id,
  d.organization_id,
  d.agent_name,
  d.name AS dashboard_name
FROM dashboard_widgets w
JOIN dashboards d
  ON d.id = w.dashboard_id
 AND d.tenant_namespace = w.tenant_namespace
WHERE w.tenant_namespace = sqlc.arg(tenant_namespace)
  AND d.workspace_id = sqlc.arg(workspace_id)
  AND d.agent_name = sqlc.arg(agent_name)
  AND d.name = sqlc.arg(dashboard_name)
  AND w.name = sqlc.arg(widget_name)
FOR UPDATE OF d, w;

-- name: DashboardDelete :one
DELETE FROM dashboards
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND workspace_id = sqlc.arg(workspace_id)
  AND agent_name = sqlc.arg(agent_name)
  AND name = sqlc.arg(name)
RETURNING id;

-- name: DashboardGetPublishReplay :one
SELECT request_hash, received_at, accepted_records
FROM dashboard_publish_idempotency
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND agent_name = sqlc.arg(agent_name)
  AND idempotency_key = sqlc.arg(idempotency_key);

-- name: DashboardReservePublishWindow :one
INSERT INTO dashboard_publish_windows (
  tenant_namespace, agent_name, window_kind, window_start, calls, records, bytes
) SELECT
  sqlc.arg(tenant_namespace), sqlc.arg(agent_name), sqlc.arg(window_kind),
  sqlc.arg(window_start), sqlc.arg(calls), sqlc.arg(records), sqlc.arg(bytes)
WHERE sqlc.arg(calls) <= sqlc.arg(max_calls)::bigint
  AND sqlc.arg(records) <= sqlc.arg(max_records)::bigint
  AND sqlc.arg(bytes) <= sqlc.arg(max_bytes)::bigint
ON CONFLICT (tenant_namespace, agent_name, window_kind, window_start)
DO UPDATE SET
  calls = dashboard_publish_windows.calls + EXCLUDED.calls,
  records = dashboard_publish_windows.records + EXCLUDED.records,
  bytes = dashboard_publish_windows.bytes + EXCLUDED.bytes
WHERE dashboard_publish_windows.calls + EXCLUDED.calls <= sqlc.arg(max_calls)
  AND dashboard_publish_windows.records + EXCLUDED.records <= sqlc.arg(max_records)
  AND dashboard_publish_windows.bytes + EXCLUDED.bytes <= sqlc.arg(max_bytes)
RETURNING calls, records, bytes;

-- name: DashboardReserveTemporalUsage :one
INSERT INTO dashboard_tenant_usage (
  tenant_namespace, temporal_records, temporal_bytes
) SELECT
  sqlc.arg(tenant_namespace), sqlc.arg(records), sqlc.arg(bytes)
WHERE sqlc.arg(records) <= sqlc.arg(max_records)::bigint
ON CONFLICT (tenant_namespace)
DO UPDATE SET
  temporal_records = dashboard_tenant_usage.temporal_records + EXCLUDED.temporal_records,
  temporal_bytes = dashboard_tenant_usage.temporal_bytes + EXCLUDED.temporal_bytes,
  updated_at = now()
WHERE dashboard_tenant_usage.temporal_records + EXCLUDED.temporal_records <= sqlc.arg(max_records)
RETURNING temporal_records, temporal_bytes;

-- name: DashboardLatestBytes :one
SELECT coalesce(sum(byte_size), 0)::bigint
FROM dashboard_latest_records
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND widget_revision = sqlc.arg(widget_revision);

-- name: DashboardReserveLatestUsage :one
INSERT INTO dashboard_agent_usage (tenant_namespace, agent_name, latest_bytes)
SELECT
  sqlc.arg(tenant_namespace) AS tenant_namespace,
  sqlc.arg(agent_name) AS agent_name,
  greatest(sqlc.arg(delta_bytes), 0)::bigint AS latest_bytes
WHERE sqlc.arg(delta_bytes) <= sqlc.arg(max_bytes)::bigint
ON CONFLICT (tenant_namespace, agent_name)
DO UPDATE SET
  latest_bytes = dashboard_agent_usage.latest_bytes + sqlc.arg(delta_bytes),
  updated_at = now()
WHERE dashboard_agent_usage.latest_bytes + sqlc.arg(delta_bytes) BETWEEN 0 AND sqlc.arg(max_bytes)
RETURNING latest_bytes;

-- name: DashboardInsertTemporalRecords :execrows
INSERT INTO dashboard_temporal_records (
  tenant_namespace, widget_revision, recorded_at, payload, byte_size
)
SELECT
  sqlc.arg(tenant_namespace), sqlc.arg(widget_revision),
  input.recorded_at, input.payload, input.byte_size
FROM jsonb_to_recordset(sqlc.arg(records)::jsonb) AS input(
  recorded_at TIMESTAMPTZ,
  payload JSONB,
  byte_size INTEGER
);

-- name: DashboardReplaceLatestRecords :exec
WITH upserted AS (
  INSERT INTO dashboard_latest_records (
    tenant_namespace, widget_revision, received_at, ordinal, payload, byte_size
  )
  SELECT
    sqlc.arg(tenant_namespace), sqlc.arg(widget_revision), sqlc.arg(received_at),
    (input.ordinality - 1)::integer, input.value->'payload', (input.value->>'byte_size')::integer
  FROM jsonb_array_elements(sqlc.arg(records)::jsonb) WITH ORDINALITY AS input(value, ordinality)
  ON CONFLICT (widget_revision, ordinal) DO UPDATE SET
    received_at = EXCLUDED.received_at,
    payload = EXCLUDED.payload,
    byte_size = EXCLUDED.byte_size
  RETURNING ordinal
)
DELETE FROM dashboard_latest_records
WHERE dashboard_latest_records.tenant_namespace = sqlc.arg(tenant_namespace)
  AND dashboard_latest_records.widget_revision = sqlc.arg(widget_revision)
  AND dashboard_latest_records.ordinal >= jsonb_array_length(sqlc.arg(records)::jsonb)
  AND EXISTS (SELECT 1 FROM upserted);

-- name: DashboardSavePublishReplay :exec
INSERT INTO dashboard_publish_idempotency (
  tenant_namespace, agent_name, idempotency_key, request_hash, received_at, accepted_records
) VALUES (
  sqlc.arg(tenant_namespace), sqlc.arg(agent_name), sqlc.arg(idempotency_key),
  sqlc.arg(request_hash), sqlc.arg(received_at), sqlc.arg(accepted_records)
);

-- name: DashboardSetStatementTimeout :one
SELECT set_config('statement_timeout', sqlc.arg(timeout), true);

-- name: DashboardReserveQueryWindow :one
INSERT INTO dashboard_query_windows (
  tenant_namespace, subject_id, window_kind, window_start, calls, cells
) SELECT
  sqlc.arg(tenant_namespace), sqlc.arg(subject_id), sqlc.arg(window_kind),
  sqlc.arg(window_start), sqlc.arg(calls), sqlc.arg(cells)
WHERE sqlc.arg(calls) <= sqlc.arg(max_calls)::bigint
  AND sqlc.arg(cells) <= sqlc.arg(max_cells)::bigint
ON CONFLICT (tenant_namespace, subject_id, window_kind, window_start)
DO UPDATE SET
  calls = dashboard_query_windows.calls + EXCLUDED.calls,
  cells = dashboard_query_windows.cells + EXCLUDED.cells
WHERE dashboard_query_windows.calls + EXCLUDED.calls <= sqlc.arg(max_calls)
  AND dashboard_query_windows.cells + EXCLUDED.cells <= sqlc.arg(max_cells)
RETURNING calls, cells;

-- name: DashboardAcquireQueryLease :one
WITH locked AS MATERIALIZED (
  SELECT
    pg_advisory_xact_lock(hashtextextended(sqlc.arg(tenant_namespace), 0)),
    sqlc.arg(tenant_namespace)::text AS tenant_namespace
), expired AS (
  DELETE FROM dashboard_query_leases
  WHERE tenant_namespace = sqlc.arg(tenant_namespace)
    AND expires_at <= now()
), acquired AS (
  INSERT INTO dashboard_query_leases (token, tenant_namespace, expires_at)
  SELECT sqlc.arg(token), locked.tenant_namespace, sqlc.arg(expires_at)
  FROM locked
  WHERE (
    SELECT count(*) FROM dashboard_query_leases leases
    WHERE leases.tenant_namespace = locked.tenant_namespace
      AND leases.expires_at > now()
  ) < sqlc.arg(max_concurrent)::integer
  RETURNING token
)
SELECT token FROM acquired;

-- name: DashboardReleaseQueryLease :execrows
DELETE FROM dashboard_query_leases
WHERE token = sqlc.arg(token)
  AND tenant_namespace = sqlc.arg(tenant_namespace);

-- name: DashboardCountInvalidRecords :one
WITH widget AS (
  SELECT kind, mode, definition
  FROM dashboard_widgets w
  WHERE w.tenant_namespace = sqlc.arg(tenant_namespace)
    AND w.revision = sqlc.arg(widget_revision)
), records AS (
  SELECT temporal.payload
  FROM dashboard_temporal_records temporal, widget
  WHERE temporal.tenant_namespace = sqlc.arg(tenant_namespace)
    AND temporal.widget_revision = sqlc.arg(widget_revision)
    AND temporal.recorded_at >= sqlc.arg(from_time)
    AND temporal.recorded_at < sqlc.arg(to_time)
    AND widget.mode = 'temporal'
  UNION ALL
  SELECT latest.payload
  FROM dashboard_latest_records latest, widget
  WHERE latest.tenant_namespace = sqlc.arg(tenant_namespace)
    AND latest.widget_revision = sqlc.arg(widget_revision)
    AND widget.mode = 'latest'
), shapes AS (
  SELECT
    records.payload,
    widget.kind,
    widget.definition,
    count(*) OVER () AS record_count,
    CASE WHEN jsonb_typeof(records.payload->'values') = 'array'
      THEN records.payload->'values' ELSE '[]'::jsonb END AS values,
    CASE WHEN jsonb_typeof(records.payload->'cells') = 'array'
      THEN records.payload->'cells' ELSE '[]'::jsonb END AS cells
  FROM records, widget
), invalid AS (
  SELECT 1
  FROM shapes
  WHERE jsonb_typeof(payload) <> 'object'
     OR (kind = 'gauge' AND record_count > 1)
     OR CASE kind
        WHEN 'line' THEN NOT (
          payload - 'values' = '{}'::jsonb AND
          jsonb_typeof(payload->'values') = 'array' AND
          jsonb_array_length(values) = jsonb_array_length(definition->'series') AND
          NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(values) value
            WHERE jsonb_typeof(value) <> 'number'
          )
        )
        WHEN 'area' THEN NOT (
          payload - 'values' = '{}'::jsonb AND
          jsonb_typeof(payload->'values') = 'array' AND
          jsonb_array_length(values) = jsonb_array_length(definition->'series') AND
          NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(values) value
            WHERE jsonb_typeof(value) <> 'number'
          )
        )
        WHEN 'step' THEN NOT (
          payload - 'values' = '{}'::jsonb AND
          jsonb_typeof(payload->'values') = 'array' AND
          jsonb_array_length(values) = jsonb_array_length(definition->'series') AND
          NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(values) value
            WHERE jsonb_typeof(value) <> 'number'
          )
        )
        WHEN 'gauge' THEN NOT (
          payload - 'values' = '{}'::jsonb AND
          jsonb_typeof(payload->'values') = 'array' AND
          jsonb_array_length(values) = 1 AND
          NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(values) value
            WHERE jsonb_typeof(value) <> 'number'
          )
        )
        WHEN 'pie' THEN NOT (
          payload - ARRAY['category', 'values'] = '{}'::jsonb AND
          jsonb_typeof(payload->'category') = 'string' AND
          jsonb_typeof(payload->'values') = 'array' AND
          jsonb_array_length(values) = jsonb_array_length(definition->'series') AND
          NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(values) value
            WHERE jsonb_typeof(value) <> 'number'
          )
        )
        WHEN 'bar' THEN NOT (
          payload - ARRAY['category', 'values'] = '{}'::jsonb AND
          jsonb_typeof(payload->'category') = 'string' AND
          jsonb_typeof(payload->'values') = 'array' AND
          jsonb_array_length(values) = jsonb_array_length(definition->'series') AND
          NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(values) value
            WHERE jsonb_typeof(value) <> 'number'
          )
        )
        WHEN 'horizontal_grouped_bar' THEN NOT (
          payload - ARRAY['category', 'values'] = '{}'::jsonb AND
          jsonb_typeof(payload->'category') = 'string' AND
          jsonb_typeof(payload->'values') = 'array' AND
          jsonb_array_length(values) = jsonb_array_length(definition->'series') AND
          NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(values) value
            WHERE jsonb_typeof(value) <> 'number'
          )
        )
        WHEN 'funnel' THEN NOT (
          payload - ARRAY['category', 'values'] = '{}'::jsonb AND
          jsonb_typeof(payload->'category') = 'string' AND
          jsonb_typeof(payload->'values') = 'array' AND
          jsonb_array_length(values) = 1 AND
          NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(values) value
            WHERE CASE WHEN jsonb_typeof(value) = 'number'
              THEN (value #>> '{}')::double precision < 0 ELSE true END
          )
        )
        WHEN 'horizontal_funnel' THEN NOT (
          payload - ARRAY['category', 'values'] = '{}'::jsonb AND
          jsonb_typeof(payload->'category') = 'string' AND
          jsonb_typeof(payload->'values') = 'array' AND
          jsonb_array_length(values) = 1 AND
          NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(values) value
            WHERE CASE WHEN jsonb_typeof(value) = 'number'
              THEN (value #>> '{}')::double precision < 0 ELSE true END
          )
        )
        WHEN 'sankey' THEN CASE
          WHEN jsonb_typeof(payload->'source') = 'string' AND
               jsonb_typeof(payload->'target') = 'string' AND
               jsonb_typeof(payload->'value') = 'number'
          THEN NOT (
            payload - ARRAY['source', 'target', 'value'] = '{}'::jsonb AND
            payload->>'source' <> payload->>'target' AND
            (payload->>'value')::double precision > 0
          )
          ELSE true
        END
        WHEN 'scatter' THEN CASE
          WHEN jsonb_typeof(payload->'series') = 'number' AND
               jsonb_typeof(payload->'x') = 'number' AND
               jsonb_typeof(payload->'y') = 'number'
          THEN NOT (
            payload - ARRAY['series', 'x', 'y', 'label'] = '{}'::jsonb AND
            (payload->>'series')::numeric = trunc((payload->>'series')::numeric) AND
            (payload->>'series')::numeric >= 0 AND
            (payload->>'series')::numeric < jsonb_array_length(definition->'series') AND
            (NOT payload ? 'label' OR jsonb_typeof(payload->'label') = 'string')
          )
          ELSE true
        END
        WHEN 'table' THEN NOT (
          payload - 'cells' = '{}'::jsonb AND
          jsonb_typeof(payload->'cells') = 'array' AND
          jsonb_array_length(cells) = jsonb_array_length(definition->'columns') AND
          NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(cells) WITH ORDINALITY AS cell(value, ordinality)
            WHERE jsonb_typeof(cell.value) <> 'object'
               OR (SELECT count(*) FROM jsonb_object_keys(cell.value)) <> 1
               OR CASE definition->'columns'->((cell.ordinality - 1)::integer)->>'type'
                  WHEN 'text' THEN jsonb_typeof(cell.value->'text') <> 'string'
                  WHEN 'number' THEN jsonb_typeof(cell.value->'number') <> 'number'
                  WHEN 'boolean' THEN jsonb_typeof(cell.value->'boolean') <> 'boolean'
                  WHEN 'datetime' THEN jsonb_typeof(cell.value->'datetime') <> 'string'
                  ELSE true
               END
          )
        )
        ELSE true
     END
)
SELECT count(*) FROM invalid;

-- name: DashboardBucketTimeSeries :many
WITH series AS (
  SELECT
    (item.ordinality - 1)::integer AS series_index,
    item.value->>'aggregation' AS aggregation
  FROM dashboard_widgets w,
       jsonb_array_elements(w.definition->'series') WITH ORDINALITY AS item(value, ordinality)
  WHERE w.tenant_namespace = sqlc.arg(tenant_namespace)
    AND w.revision = sqlc.arg(widget_revision)
), expanded AS (
  SELECT
    date_bin(
      make_interval(secs => sqlc.arg(bucket_seconds)::integer),
      r.recorded_at,
      sqlc.arg(from_time)::timestamptz
    ) AS bucket,
    r.recorded_at,
    r.id,
    (value.ordinality - 1)::integer AS series_index,
    (value.value #>> '{}')::double precision AS value
  FROM dashboard_temporal_records r,
       jsonb_array_elements(r.payload->'values') WITH ORDINALITY AS value(value, ordinality)
  WHERE r.tenant_namespace = sqlc.arg(tenant_namespace)
    AND r.widget_revision = sqlc.arg(widget_revision)
    AND r.recorded_at >= sqlc.arg(from_time)
    AND r.recorded_at < sqlc.arg(to_time)
), aggregated AS (
  SELECT
    e.bucket,
    e.series_index,
    CASE s.aggregation
      WHEN 'sum' THEN sum(e.value)
      WHEN 'average' THEN avg(e.value)
      WHEN 'minimum' THEN min(e.value)
      WHEN 'maximum' THEN max(e.value)
      WHEN 'count' THEN count(e.value)::double precision
      WHEN 'last' THEN (array_agg(e.value ORDER BY e.recorded_at DESC, e.id DESC))[1]
    END AS value
  FROM expanded e
  JOIN series s USING (series_index)
  GROUP BY e.bucket, e.series_index, s.aggregation
)
SELECT
  bucket::timestamptz AS bucket,
  jsonb_agg(value ORDER BY series_index) AS values
FROM aggregated
GROUP BY bucket
ORDER BY bucket;

-- name: DashboardReadRecords :many
SELECT received_at, ordinal, payload
FROM dashboard_latest_records
WHERE tenant_namespace = sqlc.arg(tenant_namespace)
  AND widget_revision = sqlc.arg(widget_revision)
ORDER BY ordinal
LIMIT sqlc.arg(row_limit);

-- name: DashboardAggregateCategories :many
WITH widget AS (
  SELECT mode, definition
  FROM dashboard_widgets w
  WHERE w.tenant_namespace = sqlc.arg(tenant_namespace)
    AND w.revision = sqlc.arg(widget_revision)
), source AS (
  SELECT temporal.recorded_at AS at, temporal.id AS sequence, temporal.payload
  FROM dashboard_temporal_records temporal, widget
  WHERE temporal.tenant_namespace = sqlc.arg(tenant_namespace)
    AND temporal.widget_revision = sqlc.arg(widget_revision)
    AND temporal.recorded_at >= sqlc.arg(from_time)
    AND temporal.recorded_at < sqlc.arg(to_time)
    AND widget.mode = 'temporal'
  UNION ALL
  SELECT latest.received_at AS at, latest.ordinal::bigint AS sequence, latest.payload
  FROM dashboard_latest_records latest, widget
  WHERE latest.tenant_namespace = sqlc.arg(tenant_namespace)
    AND latest.widget_revision = sqlc.arg(widget_revision)
    AND widget.mode = 'latest'
), expanded AS (
  SELECT
    source.payload->>'category' AS category,
    source.at,
    source.sequence,
    (value.ordinality - 1)::integer AS series_index,
    (value.value #>> '{}')::double precision AS value,
    widget.definition->'series'->((value.ordinality - 1)::integer)->>'aggregation' AS aggregation
  FROM source, widget,
       jsonb_array_elements(source.payload->'values') WITH ORDINALITY AS value(value, ordinality)
), aggregated AS (
  SELECT
    category,
    series_index,
    CASE aggregation
      WHEN 'sum' THEN sum(value)
      WHEN 'average' THEN avg(value)
      WHEN 'minimum' THEN min(value)
      WHEN 'maximum' THEN max(value)
      WHEN 'count' THEN count(value)::double precision
      WHEN 'last' THEN (array_agg(value ORDER BY at DESC, sequence DESC))[1]
    END AS value
  FROM expanded
  GROUP BY category, series_index, aggregation
), category_scores AS (
  SELECT
    category,
    sum(abs(value)) AS score
  FROM aggregated
  GROUP BY category
), top_categories AS (
  SELECT category
  FROM category_scores
  ORDER BY score DESC, category
  LIMIT sqlc.arg(max_categories)
), mapped AS (
  SELECT
    coalesce(top_categories.category, 'Other') AS label,
    aggregated.series_index,
    aggregated.value
  FROM aggregated
  LEFT JOIN top_categories ON top_categories.category = aggregated.category
), collapsed AS (
  SELECT label, series_index, sum(value) AS value
  FROM mapped
  GROUP BY label, series_index
)
SELECT label::text AS label, jsonb_agg(value ORDER BY series_index) AS values
FROM collapsed
GROUP BY label
ORDER BY CASE WHEN label = 'Other' THEN 1 ELSE 0 END, sum(abs(value)) DESC, label;

-- name: DashboardSampleScatter :many
WITH widget AS (
  SELECT mode
  FROM dashboard_widgets w
  WHERE w.tenant_namespace = sqlc.arg(tenant_namespace)
    AND w.revision = sqlc.arg(widget_revision)
), source AS (
  SELECT temporal.recorded_at AS at, temporal.id AS sequence, temporal.payload
  FROM dashboard_temporal_records temporal, widget
  WHERE temporal.tenant_namespace = sqlc.arg(tenant_namespace)
    AND temporal.widget_revision = sqlc.arg(widget_revision)
    AND temporal.recorded_at >= sqlc.arg(from_time)
    AND temporal.recorded_at < sqlc.arg(to_time)
    AND widget.mode = 'temporal'
  UNION ALL
  SELECT latest.received_at AS at, latest.ordinal::bigint AS sequence, latest.payload
  FROM dashboard_latest_records latest, widget
  WHERE latest.tenant_namespace = sqlc.arg(tenant_namespace)
    AND latest.widget_revision = sqlc.arg(widget_revision)
    AND widget.mode = 'latest'
), numbered AS (
  SELECT
    payload,
    row_number() OVER (ORDER BY at, sequence) AS row_number,
    count(*) OVER () AS total
  FROM source
)
SELECT payload
FROM numbered
WHERE (row_number - 1) % greatest(ceil(total::numeric / sqlc.arg(max_points))::bigint, 1) = 0
ORDER BY row_number
LIMIT sqlc.arg(max_points);

-- name: DashboardTableRows :many
WITH widget AS (
  SELECT mode
  FROM dashboard_widgets w
  WHERE w.tenant_namespace = sqlc.arg(tenant_namespace)
    AND w.revision = sqlc.arg(widget_revision)
), source AS (
  SELECT temporal.recorded_at AS at, temporal.id AS sequence, temporal.payload
  FROM dashboard_temporal_records temporal, widget
  WHERE temporal.tenant_namespace = sqlc.arg(tenant_namespace)
    AND temporal.widget_revision = sqlc.arg(widget_revision)
    AND temporal.recorded_at >= sqlc.arg(from_time)
    AND temporal.recorded_at < sqlc.arg(to_time)
    AND widget.mode = 'temporal'
  UNION ALL
  SELECT latest.received_at AS at, latest.ordinal::bigint AS sequence, latest.payload
  FROM dashboard_latest_records latest, widget
  WHERE latest.tenant_namespace = sqlc.arg(tenant_namespace)
    AND latest.widget_revision = sqlc.arg(widget_revision)
    AND widget.mode = 'latest'
)
SELECT at, payload
FROM source
ORDER BY
  CASE WHEN sqlc.arg(sort_0_ascending)::boolean AND sqlc.arg(sort_0_datetime)::boolean
    THEN (payload->'cells'->sqlc.narg(sort_0_index)::integer->>'datetime')::timestamptz END ASC,
  CASE WHEN NOT sqlc.arg(sort_0_ascending)::boolean AND sqlc.arg(sort_0_datetime)::boolean
    THEN (payload->'cells'->sqlc.narg(sort_0_index)::integer->>'datetime')::timestamptz END DESC,
  CASE WHEN sqlc.arg(sort_0_ascending)::boolean AND NOT sqlc.arg(sort_0_datetime)::boolean
    THEN payload->'cells'->sqlc.narg(sort_0_index)::integer END ASC,
  CASE WHEN NOT sqlc.arg(sort_0_ascending)::boolean AND NOT sqlc.arg(sort_0_datetime)::boolean
    THEN payload->'cells'->sqlc.narg(sort_0_index)::integer END DESC,
  CASE WHEN sqlc.arg(sort_1_ascending)::boolean AND sqlc.arg(sort_1_datetime)::boolean
    THEN (payload->'cells'->sqlc.narg(sort_1_index)::integer->>'datetime')::timestamptz END ASC,
  CASE WHEN NOT sqlc.arg(sort_1_ascending)::boolean AND sqlc.arg(sort_1_datetime)::boolean
    THEN (payload->'cells'->sqlc.narg(sort_1_index)::integer->>'datetime')::timestamptz END DESC,
  CASE WHEN sqlc.arg(sort_1_ascending)::boolean AND NOT sqlc.arg(sort_1_datetime)::boolean
    THEN payload->'cells'->sqlc.narg(sort_1_index)::integer END ASC,
  CASE WHEN NOT sqlc.arg(sort_1_ascending)::boolean AND NOT sqlc.arg(sort_1_datetime)::boolean
    THEN payload->'cells'->sqlc.narg(sort_1_index)::integer END DESC,
  CASE WHEN sqlc.arg(sort_2_ascending)::boolean AND sqlc.arg(sort_2_datetime)::boolean
    THEN (payload->'cells'->sqlc.narg(sort_2_index)::integer->>'datetime')::timestamptz END ASC,
  CASE WHEN NOT sqlc.arg(sort_2_ascending)::boolean AND sqlc.arg(sort_2_datetime)::boolean
    THEN (payload->'cells'->sqlc.narg(sort_2_index)::integer->>'datetime')::timestamptz END DESC,
  CASE WHEN sqlc.arg(sort_2_ascending)::boolean AND NOT sqlc.arg(sort_2_datetime)::boolean
    THEN payload->'cells'->sqlc.narg(sort_2_index)::integer END ASC,
  CASE WHEN NOT sqlc.arg(sort_2_ascending)::boolean AND NOT sqlc.arg(sort_2_datetime)::boolean
    THEN payload->'cells'->sqlc.narg(sort_2_index)::integer END DESC,
  at DESC,
  sequence DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: DashboardDeleteExpired :one
WITH expired AS MATERIALIZED (
  SELECT temporal.id, temporal.tenant_namespace, temporal.byte_size
  FROM dashboard_temporal_records temporal
  WHERE temporal.recorded_at < sqlc.arg(cutoff)
  ORDER BY temporal.recorded_at, temporal.id
  FOR UPDATE SKIP LOCKED
  LIMIT sqlc.arg(batch_size)
), removed AS (
  DELETE FROM dashboard_temporal_records r
  USING expired
  WHERE r.id = expired.id
  RETURNING r.tenant_namespace, r.byte_size
), totals AS (
  SELECT tenant_namespace, count(*)::bigint AS records, sum(byte_size)::bigint AS bytes
  FROM removed
  GROUP BY tenant_namespace
), adjusted AS (
  UPDATE dashboard_tenant_usage u
  SET temporal_records = greatest(0, u.temporal_records - totals.records),
      temporal_bytes = greatest(0, u.temporal_bytes - totals.bytes),
      updated_at = now()
  FROM totals
  WHERE u.tenant_namespace = totals.tenant_namespace
)
SELECT count(*)::bigint AS deleted_records, coalesce(sum(byte_size), 0)::bigint AS deleted_bytes
FROM removed;

-- name: DashboardDeleteExpiredAccounting :exec
DELETE FROM dashboard_publish_idempotency
WHERE created_at < sqlc.arg(cutoff);

-- name: DashboardDeleteExpiredWindows :exec
WITH publish AS (
  DELETE FROM dashboard_publish_windows publish_windows
  WHERE publish_windows.window_start < sqlc.arg(cutoff)
), query AS (
  DELETE FROM dashboard_query_windows query_windows
  WHERE query_windows.window_start < sqlc.arg(cutoff)
)
DELETE FROM dashboard_query_leases
WHERE expires_at <= now();
