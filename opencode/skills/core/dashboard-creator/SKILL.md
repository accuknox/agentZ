---
name: dashboard-creator
description: Design and maintain secure backend-driven AgentZ dashboards.
---

# Dashboard creator

Use `manage_dashboards` to list or inspect existing definitions before changing one. Create and replace definitions only after the producing task has been exercised manually and the actual record shape is known.

A dashboard has one stable DNS-label `name`, human-facing title and description, and a closed field contract:

- Dimensions are strings used for grouping and filtering.
- Measures are finite numbers used for aggregation.
- A field name is unique across both sets. Keep the total at 32 or fewer.
- Filters reference declared dimensions.
- Widgets reference declared fields. Supported kinds are metric, line, area, bar, donut, and table.

Metric, line, area, bar, and donut widgets require a measure and one of `sum`, `avg`, `min`, `max`, or `count`. Donut widgets require `group_by`. Table widgets require declared `columns`. Use `third`, `half`, or `full` widths to establish a coherent reading order.

Definitions are data, not executable presentation code. Never put SQL, JSONPath, JavaScript, CSS, chart-library properties, arbitrary colors, URLs, or secrets in a definition. The gateway owns query compilation, output bounds, and the chart palette.

Use `get` immediately before `replace` and pass its exact revision. Do not retry a revision conflict blindly; inspect the newer definition and reconcile the intended edit.

After creation, publish a small representative dataset with `write_dashboard_data` and verify every widget in the web dashboard before considering the work complete.
