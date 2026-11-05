---
name: workflow-scheduler
description: Use when creating, changing, or deleting workflow schedules.
license: Apache-2.0
compatibility: opencode
metadata:
  source: bundled-defaults
  domain: core
---

# Workflow scheduler

## Before saving

1. Read the saved definition with `get_workflow` and discover existing schedules with
   `list_workflow_schedules`. Call the `workflow-creator` skill before creating or revising a
   definition. Scheduling an unchanged saved workflow does not require authoring it again.
2. Establish the cron expression, runtime inputs, timeout, and conversation delivery. Resolve
   missing information before creating the schedule.
3. Use the workflow-scheduling tools. Report the saved schedule and whether results will return to
   this conversation after the tool succeeds.

## Conversation delivery

Set `subscribe=true` when the user wants reports, alerts, or follow-up here. A request such as "Give
me a daily digest" implies delivery here unless another destination is specified. For execution
alone, stored results, or delivery elsewhere, omit `subscribe` or set it to `false`, unless
follow-up here is also requested.

Choose delivery from the user's requested outcome in this conversation. A workflow's reporting
instructions or another schedule's subscription do not establish that the user wants updates here.

If the request suggests follow-up but leaves its delivery unclear, ask a short yes/no question, such
as "Should I post updates from these runs here?" Wait for the answer before creating the schedule.
Clear requests need no question.

A subscription returns every run result, including failures, for your review. It does not require a
visible message. For conditional alerts, subscribe and apply the user's reporting conditions when
results arrive. The workflow itself does not need to filter its results. Call the `workflow-results`
skill before reviewing a completed run.

Examples:

- "Give me a daily news digest." → `subscribe=true`.
- "Check hourly and tell me when the build passes." → `subscribe=true`; return exactly `NO_UPDATE`
  when there is nothing to report.
- "Refresh the dashboard hourly." → `subscribe=false`.
- "Email the weekly report to finance." → `subscribe=false`.

## Schedule changes

- Use stable DNS labels up to 32 characters for schedule and workflow names. If the schedule name
  exists, report the conflict and ask for a new name.
- For typed workflows, use `inputs`; for arbitrary JSON workflows, use one JSON-encoded value in
  `arbitrary_json`. Pass only the matching argument. For workflows without inputs, omit `inputs` or
  pass `{}`.
- Before an update, read the existing schedule. `workflow_name`, `schedule`, and `timeout_seconds`
  are full replacements and must be supplied together. The update tool preserves existing
  conversation delivery.
- Deleting a schedule stops future runs and their notifications. Deletion does not merely mute
  messages. Set `confirmed=true` only when the user explicitly requested deletion; otherwise leave
  it false so the tool asks for confirmation. Deleting an absent schedule fails.
