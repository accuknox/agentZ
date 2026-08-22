---
name: dashboard-publisher
description: Write dashboard records that match a saved AgentZ dashboard definition.
---

# Dashboard publisher

Call `manage_dashboards` with `get` before the first write. Each record may use only fields declared by that dashboard.

- `observed_at` is the time the fact occurred, in RFC 3339 format.
- `dimensions` contains string values only.
- `measures` contains finite numeric values only.
- `record_key` is optional for append and mandatory for upsert.

Use `append` for observations that should remain separate. Use `upsert` for current state that replaces an older record. Derive `record_key` from the source record's stable ID, not a timestamp or random value. Each upsert keeps the record for 30 days from that write.

Write at most 100 records per call. Keep numbers as numbers. Do not guess numbers from strings, add undeclared fields, fill missing values with zero, or publish secrets and raw sensitive payloads. If the source fields do not match the dashboard, update the dashboard from an interactive session before writing data.

Scheduled workflows may call `write_dashboard_data`. They cannot change dashboards or delete records.
