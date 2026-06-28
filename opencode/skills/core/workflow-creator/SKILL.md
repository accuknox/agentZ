---
name: workflow-creator
description: Create or update reusable workflow DAGs. Use when authoring or revising saved workflows. Must be mandatorily used before calling the create_workflow tool.
license: Apache-2.0
compatibility: opencode
metadata:
  source: bundled-defaults
  domain: core
---

# Workflow Creator

Treat the workflow as a saved directed acyclic graph:

- each node is one execution step
- each edge is one allowed transition
- branching belongs on edges, not inside node instructions

## Authoring Rules

- Treat recurring automation, scheduled execution, and reusable procedures as workflow-authoring tasks, not graph-only tasks.
- Before calling `create_workflow`, execute the requested task manually once with the concrete user inputs or the closest accessible substitute.
- For non-trivial reusable logic, create or update a skill or script before saving the workflow so the repeated behavior lives in one deterministic place.
- End-to-end verification is required before saving the workflow. Brief or shallow checks are not enough.
- Finalize the full graph before calling `create_workflow`.
- Keep `workflow_name` to a DNS label up to 32 characters, for example `repo-triage`.
- Keep each `node.name` unique and in the same DNS-label format.
- Ensure the graph is connected and acyclic.
- Ensure the graph has at least one start node and one terminal node.
- Keep node instructions concrete. Each node must define `instructions`, `goal`, and `done_criteria`.
- Add `preferred_skills` when a node should load specific OpenCode skills before execution.
- Add `preferred_tools` only when it gives real execution guidance.

## Input Schema Rules

- Omit `inputs` entirely when the workflow takes no parameters.
- When present, `inputs` must be a flat object keyed by input name.
- Each input must be a schema object with at least `type` and `required`.
- Supported input types are scalar only: `string`, `integer`, `number`, `boolean`.
- Allowed input keys are:
  `type`, `description`, `required`, `default`, `enum`, `minLength`,
  `maxLength`, `pattern`, `format`, `minimum`, `maximum`,
  `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`.
- Put `required` inside each input schema object. Do not use top-level JSON Schema `required` arrays inside one input definition.
- Do not use nested object or array schemas.
- Do not include extra JSON Schema metadata such as `$schema`, `title`,
  `properties`, `items`, `additionalProperties`, `oneOf`, `anyOf`, or
  `allOf`.
- Workflow definition inputs declare the schema only. Runtime workflow inputs are separate JSON values validated against that schema later.

## Branching Rules

- Use multiple outgoing edges only when the next step depends on a decision or observed outcome.
- For straight-line transitions, set `branch_label` and `condition_summary` to empty strings.
- If a node has multiple outgoing edges, every outgoing edge must have a non-empty `branch_label` and `condition_summary`.
- Do not use an unlabeled default edge from a branching node.

## Conflict Handling

- If the service reports that `workflow_name` already exists, surface the conflict.
- Do not rename the workflow automatically.

## Pre-Save Checklist

Before saving a workflow, confirm all of the following:

- [ ] You manually executed the intended task once.
- [ ] The reusable logic was extracted into a skill or script when the procedure was not trivial.
- [ ] You exercised the full happy path end-to-end.
- [ ] The workflow DAG reflects the verified procedure rather than a guess from the prose request.

If any checklist item is blocked, keep working on the blocker or report it explicitly. Do not save the workflow as if the task had already been verified.

## Example: Daily Tech News Aggregation Workflow

User request:

> Every morning, collect important tech news from a list of sources and
> produce a short digest grouped by topic.

Expected authoring behavior:

1. Manually fetch today's articles from the configured sources once.
2. De-duplicate articles that cover the same story.
3. Verify ranking logic for importance, freshness, and source credibility.
4. Create or update a deterministic summarization skill with script(s) for clustering and formatting the digest, perhaps a python script.
5. Save the workflow only after the manual aggregation succeeds end-to-end.

Do not jump directly from this prose request to `create_workflow`.

## Valid Pattern

```json
{
  "workflow_name": "repo-triage",
  "title": "Repository Triage and Fix Routing",
  "summary": "Inspect a reported issue, decide whether it is reproducible, then route to fix or clarification.",
  "inputs": {
    "issue_url": {
      "type": "string",
      "required": true,
      "format": "uri",
      "description": "Issue or report URL to inspect first."
    },
    "max_files": {
      "type": "integer",
      "required": false,
      "default": 50,
      "minimum": 1,
      "maximum": 500
    }
  },
  "nodes": [
    {
      "name": "intake",
      "instructions": "Read the report and inspect repository context before choosing the next step.",
      "goal": "Classify the reported issue.",
      "done_criteria": "The issue is understood well enough for investigation.",
      "preferred_skills": ["typescript-pro"],
      "preferred_tools": ["read", "grep", "glob"]
    },
    {
      "name": "reproduce",
      "instructions": "Reproduce or disprove the reported behavior with the available information.",
      "goal": "Confirm current behavior.",
      "done_criteria": "The bug is reproduced or ruled out.",
      "preferred_tools": ["bash", "read"]
    },
    {
      "name": "fix",
      "instructions": "Implement and verify a safe fix once the bug is reproduced.",
      "goal": "Land a safe code change.",
      "done_criteria": "Checks are complete and the fix is verified.",
      "preferred_tools": ["edit", "bash"]
    },
    {
      "name": "clarify",
      "instructions": "Gather the missing information needed to continue investigation.",
      "goal": "Unblock reproduction.",
      "done_criteria": "The missing inputs are enumerated for the user."
    }
  ],
  "edges": [
    {
      "source": "intake",
      "target": "reproduce",
      "branch_label": "",
      "condition_summary": ""
    },
    {
      "source": "reproduce",
      "target": "fix",
      "branch_label": "reproduced",
      "condition_summary": "The reported behavior is reproduced locally."
    },
    {
      "source": "reproduce",
      "target": "clarify",
      "branch_label": "needs-info",
      "condition_summary": "The issue cannot be reproduced with current information."
    }
  ]
}
```

## Invalid Patterns

- `"inputs": { "target_url": "string" }`
- `"inputs": { "repo": { "type": "object", "required": true } }`
- `"inputs": { "first_input": { "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "string", "required": true } }`
- Saving a workflow directly from a prose request without manually exercising the task first.
- Skipping skill or script creation for non-trivial reusable automation.
- Relying on brief testing instead of a real end-to-end run of the verified path.
