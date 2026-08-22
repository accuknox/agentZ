---
name: dashboard-creator
description: Create and update AgentZ dashboards without executable query or presentation code.
---

# Dashboard creator

Use `manage_dashboards` to inspect existing dashboards before changing one. Run the task that will publish the data at least once, then use its actual fields to design the dashboard.

A dashboard has a stable DNS-label `name`, a title, a description, and a field schema.

- Dimensions are strings used for grouping and filtering.
- Measures are finite numbers used for aggregation.
- A name can appear in either dimensions or measures, never both. A dashboard may declare up to 32 fields in total.
- Filters reference declared dimensions.
- Every dashboard has a built-in calendar that filters `observed_at`. Keep definition filters categorical. Never create a date or time filter.
- Widgets reference declared fields. Supported kinds are metric, line, area, bar, donut, and table.

Metric, line, area, bar, and donut widgets require a measure and one of `sum`, `avg`, `min`, `max`, or `count`. Donut widgets also require `group_by`. Table widgets require `columns`. Put summary metrics before charts and tables, then choose `third`, `half`, or `full` for each widget's width.

Never put SQL, JSONPath, JavaScript, CSS, chart-library properties, colors, URLs, or secrets in a definition. The gateway chooses the SQL, caps each result, and assigns chart colors.

Call `get` immediately before `replace` and pass the returned revision. If `replace` reports a revision conflict, fetch the dashboard again and apply your change to the newer definition.

After creation, publish enough test records to cover every filter and grouping used by the widgets. Open the dashboard and check every widget.
