---
name: dashboard-publisher
description: Publish typed workflow observations to AgentZ dashboard datasets.
---

# Dashboard publisher

Inspect the dashboard definition with `manage_dashboards` before the first write. Every record must use only declared fields:

- `observed_at` is the time the fact occurred, in RFC 3339 format.
- `dimensions` contains string values only.
- `measures` contains finite numeric values only.
- `record_key` is optional for append and mandatory for upsert.

Use `append` for immutable observations and event history. Use `upsert` for replaceable current state, with a stable key derived from the source identity. Do not use timestamps or random values as upsert keys. Reusing a key intentionally renews that row's 30-day retention period.

Publish in batches of at most 100. Do not stringify numbers, parse strings into guessed numbers, invent undeclared fields, add placeholder zeroes for missing facts, or include secrets and raw sensitive payloads. If the source does not match the contract, stop and revise the interactive definition instead of coercing the data.

Scheduled workflow sessions may publish with `write_dashboard_data`, but they cannot create, replace, or delete dashboards and cannot delete records.
