# Workflow evaluations

Start at **Workflows** in the right workspace navigation, select an agent and workflow, then open **Evaluations**. Graph, Runs, and Evaluations preserve the workflow selection. Runs includes manual, scheduled, webhook, and evaluation runs.

## Create a comparison

1. Add representative inputs using the workflow's fields or JSON editor. Import a JSON array of cases, CSV columns `name,inputs,expected`, or inputs from past runs. CSV `inputs` contains JSON. Historical outputs are not automatically treated as correct answers.
2. Choose models from the agent's configured providers. Tool-capable models and their declared variants are available. The first selection is the initial display baseline.
3. Supply expected text, a quality rubric, or both. Expected text matches exactly after trimming surrounding whitespace. A rubric requires an explicit judge model.
4. Review repetitions, timeout, execution count, and live-tool acknowledgement. Save a draft or run. A saved draft can be edited and launched using its existing identity.

Each execution has a fresh session and an explicit model configuration. The workflow definition, cases, candidates, and scoring policy are frozen. Files and external services remain shared with the source agent. The review and results screens label this as an exploratory comparison.

## Read the results

The leaderboard shows scores, baseline deltas, task success, tokens, task tool calls, reported cost, and duration. Partial measurement coverage is visible. Changing the baseline changes displayed deltas without changing recorded scores.

The case matrix exposes each repetition. Filter failures, regressions, improvements, inconsistent scores, or grading errors. Select an attempt for output comparisons, text diff, check reasons, tool arguments/results, and candidate/judge usage. Evidence can be expanded; closing it returns keyboard focus to the selected attempt. Filters, baseline, and selected attempt are linkable.

Cancellation stops admitted sessions and prevents later attempts from starting. Completed evidence remains available. Regrading uses retained output and usage, creates a new assessment revision, and preserves the preceding revision in storage. Export includes the frozen configuration and retained evidence. Archive removes the history entry while preserving direct API access.

## Scoring

There is no universal industry-standard weighting of quality, tokens, tools, and time. The [research](research/workflow-evaluation-scoring.md) compares framework aggregation and benchmark scoring. `reference-v1` is an explicit AgentZ policy, not an external standard.

Failed workflow execution or a failed mandatory check earns zero. Quality below the configured minimum also earns zero. Missing evidence or failed grading leaves an otherwise successful attempt unscored.

For a passing attempt:

```text
T = min(1, reference_tokens / max(1, measured_tokens))
C = min(1, reference_task_calls / max(1, measured_task_calls))
D = min(1, reference_seconds / max(1, measured_seconds))
efficiency = (T + C + D) / 3
score = 100 × quality × (1 − penalty_weight + penalty_weight × efficiency)
```

References are frozen for the evaluation. They are independent of the selected display baseline and other candidates. Savings below a reference do not add quality points. Cost is reported separately to avoid silently adding another correlated penalty. Scores round to two decimals before aggregation. Cases receive equal weight; the fixed repetition count makes the attempt mean equivalent to averaging repeats within each case, then cases.

The default penalty weight is zero. This is a quality-only pilot until someone establishes meaningful workflow references. Raw resources remain visible. The implementation does not claim calibrated recommendations, confidence intervals, or controlled causal rankings.

Candidate token totals include input, output, reasoning, cache reads, and cache writes reported by OpenCode, including descendant sessions. Usage lists the actual models used; delegated agents retain their configured models. Workflow protocol calls are counted separately from task tools. Judge usage is separate. Reported cost may be zero when provider pricing is unavailable. Duration uses session message timestamps, including the final answer. Evidence collection waits for an idle session and complete messages/tools.

## Operation

Run the existing migration command before starting the gateway. The new tables belong to the existing workflow migration stream. Generate contracts with `make generate`; never edit generated clients or CRDs directly.

The gateway owns the durable PostgreSQL queue. Workers use expiring leases and deterministic WorkflowRun names. Admission persists the session identity before sending its asynchronous prompt, so recovery inspects existing work rather than replaying live tools. Permissions are checked again before worker execution.

The Helm gateway pod includes the `evaluator` sidecar. Its pinned Promptfoo package runs allowlisted exact-output and rubric assertions. The HTTP service binds to loopback port 8091, validates the generated internal contract, denies judge tool permissions, and aborts/deletes judge sessions. Grading has bounded timeouts. Container readiness checks `/health`.

For local development, run `bun install --frozen-lockfile` and `bun start` in `evaluator/` alongside the normal gateway and web commands. The gateway flag `--evaluation-grader-url` defaults to `http://127.0.0.1:8091`. CI builds the evaluator image for both configured architectures. The Helm image supports tags and digests.

History returns the latest 100 compact summaries. Each evaluation supports at most 1,000 workflow executions, ten models, and ten repetitions. Evidence currently lives in PostgreSQL JSONB. This is not the 15,000-attempt scale target from the original proposal.

## Verification on 2026-09-25

Tests used an authenticated browser, the existing PostgreSQL/OpenBao/Kubernetes services, a test agent in the general workspace, and controlled OpenAI-compatible inference. The existing coding workspace was not changed. Controlled model outputs exercise execution and grading deterministically; they do not measure actual model capability.

| Scenario | Result |
| --- | --- |
| Right-navigation entry, workflow tabs, full setup and launch | Passed in Chromium |
| Workflow input fields, JSON errors, arbitrary JSON arrays/scalars, required grading settings | Passed |
| CSV import, edit and save draft, launch same identity | Passed |
| Two models with correct and incorrect exact outputs | Scores 100 and 0; candidate usage retained |
| Rubric judging and repeated attempts | Both repetitions graded; candidate 880 tokens and judge 220 tokens recorded separately |
| Token-reference penalty | 880 tokens against a 440-token reference at weight 0.3 produced score 95 |
| Duplicate launch and conflicting duplicate settings | One evaluation accepted; conflicting settings rejected |
| Invalid inputs, unavailable model, missing live-tool acknowledgement | Rejected |
| Active and queued cancellation | Active session aborted/deleted; later model never started |
| Worker process killed during execution | Same session recovered; one WorkflowRun; completed score |
| Final answer delayed after workflow success | No premature score; final output and all 880 tokens retained |
| Failed execution and timeout | Failure retained with score zero |
| Empty final answer following intermediate text | Intermediate text was not graded as the final answer |
| Grader stopped, then restored | Attempts remained unscored; regrade restored scores without rerunning tools |
| Delegated session usage | 880 root plus 370 child tokens; both actual models recorded; root output preserved |
| Original session deleted before regrade | Retained evidence regraded successfully |
| WorkflowRun deletion after its session was already deleted | Finalizer completed without bypassing cleanup |
| Archive | Removed from list; direct API evidence preserved |
| Wrong agent/workflow, cross-workspace credential, unauthenticated read | Access denied or not found |
| Desktop, 390px viewport, light/dark themes, mobile navigation, keyboard evidence tabs and focus return | Manually exercised |
| Read-only evaluator container with writable temporary directory | Built, health checked, and used for regrading |
| Go tests, Go lint, frontend production build/typecheck/lint, evaluator build/typecheck, Helm lint | Passed |

The development database already contained legacy tables without their historical migration ledger. The new migration was applied transactionally for testing; the old ledger was not fabricated. OpenBao's stale Kubernetes reviewer token was repaired to use its mounted rotating service-account token. Temporary test network access was scoped to the existing kind node.

Temporary test agents, sandboxes, providers, workflows, runs, evaluation records, login session, network rule, credential copies, and local service processes were removed after verification. The existing coding workspace remained healthy. The generated WorkflowRun CRD, evaluation database migration, and OpenBao reviewer configuration remain applied.

## Remaining target-plan work

The original [proposal](research/workflow-evaluation-plan.md) describes a broader product. Isolated/resettable environments, human calibration and review, structured/artifact/state assertions, budget enforcement, reusable versioned datasets, cross-evaluation comparisons, assessment-history browsing, statistical uncertainty, object-storage retention, and server-paginated evidence are not implemented here. Drafts save explicitly; they do not autosave incomplete forms. No claim is made that every acceptance target in that proposal is complete.

Cleanup reviewed the feature's handwritten Go/TypeScript, generator sources, SQL, and deployment changes, with repository-wide Go lint and tests. Generated files were changed through their generators. Unchanged handwritten files were screened for helper/normalizer patterns, not exhaustively reviewed line by line.
