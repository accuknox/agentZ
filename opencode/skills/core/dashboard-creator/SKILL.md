---
name: dashboard-creator
description: Create and maintain backend-driven dashboards. Must be used before create_dashboard or publish_dashboard_data.
license: Apache-2.0
compatibility: opencode
metadata:
  source: bundled-defaults
  domain: core
---

# Dashboard Creator

Build the dashboard from values you have already computed. The gateway validates, stores, limits, and queries data; it is not a transformation engine.

## Sequence

1. Call `list_dashboards` before choosing a name.
2. Finalize every widget definition before calling `create_dashboard`. Definitions are immutable.
3. Call `get_dashboard` immediately before publishing and use the returned `data_revision` for each widget.
4. Call `publish_dashboard_data` once per widget update, with at most 100 records.
5. If a definition is wrong or a widget reports invalid stored data, delete the dashboard, recreate it, and publish corrected data.

## Widget contracts

- `line`, `area`, `step`: temporal only; 1–5 series. Each record contains only `values`, with one number per series.
- `pie`: latest only; exactly one series. Each record contains only `category` and one `values` entry.
- `bar`, `horizontal_grouped_bar`: temporal or latest; 1–5 series. Each record contains only `category` and one value per series.
- `scatter`: temporal or latest; 1–5 declared series. Each record contains `series`, `x`, `y`, and optionally `size` and `label`.
- `gauge`: latest only; exactly one series and an increasing `minimum`/`maximum`. Publish exactly one record containing one value.
- `table`: temporal or latest; 1–12 columns and no series. Each record contains only `cells`, one cell per declared column. A cell must contain exactly one matching key: `text`, `number`, `boolean`, or `datetime`.

Use `sum`, `average`, `minimum`, `maximum`, `last`, or `count` to declare how temporal values combine inside a server-selected time bucket.

## Layout

- Every widget has the same height in the UI.
- Choose `full`, `half`, or `third` width.
- Prefer a varied layout. Use full width for dense tables and multi-series time charts; use half or third width for gauges and compact categorical charts.
- Keep titles short. Do not encode units or explanatory paragraphs into titles; put units in series or column labels.

## Data rules

- Temporal publishing appends every accepted record using gateway receive time. Retention is 30 days.
- Latest publishing atomically replaces that widget's current snapshot.
- Compute categories, series values, scatter coordinates, table cells, and gauge values before publishing.
- Never send extra fields “just in case.” Shape mismatches are rejected.
- Do not exceed five series, twelve table columns, or one hundred records per publish.
