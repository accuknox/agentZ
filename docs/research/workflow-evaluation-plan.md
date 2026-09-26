# Workflow evaluations: final proposed plan

Date: 2026-09-25. Scope: a complete workflow evaluation feature, with the user journey and comparison experience driving implementation. This document records the proposed target. See [implementation and verification](../workflow-evaluations.md) for shipped behavior, verified scenarios, and remaining work.

## Product outcome

A user starts at **Workflows in the right workspace navigation**, selects a workflow, compares model configurations on representative cases, and gets an explainable 0–100 score plus enough evidence to choose a model. The interface must make it easy to answer which model to choose, where it fails, and what its quality costs.

Deliver a native AgentZ experience. Use Promptfoo as the first replaceable grading adapter, subject to contract tests against its released artifact. AgentZ owns execution, evidence, scoring policies, permissions, and UI.

## Existing application and navigation

The existing entry points are `web/components/blocks/sidebar/workspace-navigation.tsx` and `web/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/graphs/page.tsx`. Workflows currently opens a graph with remembered agent/workflow selectors. Keep this context and the existing graph.

The checked-out sidebar defaults to the left. The requested design explicitly places workspace navigation on the right. Set the workspace shell placement and layout order together; verify its expanded, collapsed, mobile, and keyboard states. Do not create a second Workflows navigation item. Account and organization settings are outside this placement change.

Add workflow-level tabs beneath the persistent selection header: **Graph | Runs | Evaluations**. Keep the current graph URL valid. Add `/workflows/runs` and `/workflows/evaluations` under the workspace root, preserving agent/workflow context. Existing trigger-run routes remain valid. New evaluation detail routes use stable IDs and resolve their own immutable workflow identity rather than trusting query parameters.

The Workflows item stays active for graph, runs, evaluations, and evaluation detail pages. Tab switches and browser Back preserve selection and filters. Changing workflows clears incompatible selected evaluations and shows that workflow's saved configuration. Unsaved case edits offer save/discard; drafts are otherwise autosaved with visible status.

Primary journey:

```text
Right navigation: Workflows
  -> Selected agent + workflow
  -> Evaluations
  -> New evaluation
  -> Cases -> Models -> Success criteria -> Review and run
  -> Live progress -> Results -> Case comparison -> Evidence
```

Use plain user-facing terms: Test cases, Models, Success criteria, Evaluation, Attempt. Internal suite, candidate, trial, and assessment types do not need to appear in onboarding.

## Competitive reference

Source research covers Promptfoo, Braintrust, LangSmith, Langfuse, and Phoenix. See [UX research](workflow-evaluation-ux.md) for the comparison and its access limitations.

Promptfoo provides the case/model matrix, result filters, cell details, configurable columns, and URL-preserved filters. Its checked-out official viewer screenshot was visually inspected. [Official viewer](https://www.promptfoo.dev/docs/usage/web-ui/)

Braintrust documents baseline alignment, regression sorting, output diffs, pairwise review, and grouped repeated attempts. These establish concrete interaction targets. [Official comparison guide](https://www.braintrust.dev/docs/evaluate/compare-experiments)

Our intended improvements are workflow-specific: inherit inputs and configuration; start from historical runs; connect low scores to workflow steps and tool evidence; explain recommendations in ordinary language; distinguish execution failures from grading errors. These are design goals, not claims of proven superiority over those products.

## Screen specification

### 1. Evaluations landing

Keep workflow identity and tabs visible. The primary action is **New evaluation**. A first-time state explains the outcome in one sentence: "Compare models on this workflow's real inputs." Offer **Use past runs**, **Add test cases**, and **Import CSV or JSON**. The first two must work without editing configuration files.

After evaluations exist, show a compact latest-comparison summary and an evaluation history table. Columns: name, status, models, cases/attempts completed, highest eligible score, baseline change, cost, and date. Show "No eligible model" or "Scoring incomplete" when appropriate. Keep numeric comparison badges only for compatible suite/policy revisions. Actions: open, duplicate setup, compare compatible evaluations, export, archive. Include search and status/date filters.

Test cases and scoring settings are reusable workflow resources accessible here. Do not make users learn dataset/project administration before their first evaluation.

### 2. New evaluation

A full-width page with a four-step indicator and persistent setup summary. Avoid a narrow modal for editing datasets or comparing models. Back/Next preserve entries; direct step navigation is allowed once required earlier fields are valid. Advanced settings are disclosed near the fields they affect.

**Cases.** Build forms from workflow input definitions. Offer inline table editing, bulk paste, CSV/JSON mapping preview, tags, expected results, and attachments. Import past-run inputs as drafts; previous outputs do not automatically become truth. Show per-row validation and counts of ready/incomplete cases. Review the exact seed files and external tool fixtures needed to reproduce execution. Version saved cases.

**Models.** Search permitted provider/model configurations and add candidates. Preselect the workflow's resolved current configuration as the baseline when it is available. Labels include provider and reasoning/settings differences so two configurations of the same model remain distinguishable. Validate tool support and access. MVP substitutes one selected model configuration for all model calls controlled by the workflow runner. Detect and reject incompatible node-specific overrides instead of silently ignoring them. Matrix configuration per node is future scope.

**Success criteria.** Present human-readable rules: required output, structured fields, artifact/state checks, tool requirements, and a quality rubric. Separate mandatory checks from graded quality. Provide a judge preview against a selected recorded output and show its reason. Explain any judge cost before execution. Keep advanced thresholds and scoring parameters behind an expandable policy panel, with a numerical preview of quality/resource tradeoffs. Never allow a missing rubric/assertion set to count as a perfect result.

**Review and run.** Show workflow revision, case count, candidates, repetitions, total planned workflow executions, environment, timeout, run budget, and judge configuration. Distinguish estimated candidate cost from grading cost and unknown pricing from zero. Provide a small pilot action and full-run action. Pilot results are exploratory; exclude calibration cases from held-out selection claims. Running freezes the configuration. Double-clicking launch creates one evaluation.

No scoring-policy calibration is forced into every launch. A validated workflow policy and existing cases make subsequent evaluations a short model-selection-and-review flow.

### 3. Live evaluation

Use the same page and table that will show completed results. Display planned, running, awaiting grading, graded, failed, and unscored counts. Phase labels include Preparing environment, Running workflow, Collecting evidence, and Grading. Display actual spend, elapsed time, and estimates only when there is enough evidence to estimate them.

Model rows show progress and provisional measurements. Preserve row order while results stream in. Never crown a model while competing runs are pending. Allow users to navigate away and return, copy the link, or cancel. Explain cancellation scope and retain completed evidence. Reconnect without losing rows or duplicating events. A budget stop reports committed/observed spend and any in-flight overshoot; do not promise an exact dollar ceiling where provider metering is delayed.

Retry infrastructure/grader failures separately. Retrying a genuine model failure creates a new recorded attempt/evaluation, preserving the original. Regrade retained evidence without re-executing tools.

### 4. Results and model selection

Top area: workflow/evaluation identity, configuration revision, baseline selector, compare selector, export, and duplicate setup. Then a short recommendation with evidence, or a clear result such as **No clear winner**, **No model meets the requirements**, or **More evidence needed**.

The primary leaderboard includes Model, Workflow score /100, delta versus baseline, task success, quality, task tool calls, tokens, cost per attempt, and duration. Use compact defaults with optional columns. A score cell opens the exact component calculation and policy. Totals include unsuccessful attempts; separate cost per successful task has an explicit denominator and is unavailable when there are no successes.

Below it, make a case comparison matrix the main working area. Rows are stable case IDs, columns are candidate configurations, and cells show score, pass/fail/unscored status, output preview, and repeat count. Pin the case column, selected baseline, and column headers. Provide All, Failures, Regressions, Improvements, Inconsistent, and Grading errors filters, plus tag/text search. Expand a case to inspect all attempts; do not hide variability behind its average.

Add optional quality-versus-cost/latency scatter plots with accessible table equivalents. Display statistical intervals and models where no competitor is both better and cheaper. Charts supplement the case matrix.

Comparison uses exact case and policy revisions. When histories differ, explain incompatibility. Permit an explicitly labeled shared-case exploratory comparison with coverage counts; disable headline improvement/winner claims. Changing the display baseline changes deltas only, not recorded scores or resource reference anchors.

### 5. Case comparison and evidence

Clicking a cell opens a resizable detail panel inside the content area, beside the matrix and separate from the right global navigation. Provide full-screen mode for long outputs, and a full-page equivalent on small screens. Keep selection, scroll, and filters when closing. Support previous/next case and direct links to attempts.

Show expected outcome and candidate/baseline outputs side by side. Offer text diff, structured JSON diff, and safe Markdown rendering. Long output is explicitly truncated with Load full output, never silently omitted from the grader's evidence contract.

Tabs: **Output | Checks | Workflow steps | Usage**. Each failed check includes its reason and evidence reference. Workflow steps connect the existing graph to a chronological tool timeline, including arguments, results, retries, and durations. Mark node attribution unavailable where instrumentation cannot establish it; do not fabricate a node association from an LLM guess.

Review actions: flag, comment, prefer A/B/tie in a blinded pairwise mode, and add the case to a regression set. Human judgments retain author/time and sit beside automated grades. Changing a grade or policy creates a new assessment revision with a visible diff, preserving the original.

Selecting a preferred model records a recommendation and baseline for future comparisons. Automatic production switching is outside this release. The result page can export the selected configuration and link to its existing configuration editor; evaluation does not silently change production behavior.

## Visual and interaction standard

Use the application's Archivo typography, color tokens, light/dark themes, table controls, and graph vocabulary. The visual direction is a focused analysis workspace: restrained surfaces, compact aligned numbers, clear spacing, and enough room for output text. Reserve accent color for actions, selection, and meaningful data states. Avoid decorative score gauges and competing dashboard cards.

- Keep the workflow identity, baseline, and next action visible at relevant points in the journey.
- Use tabular numerals, units in headers, meaningful decimal precision, and explicit metric direction. A lower token/cost value is an improvement only under the declared policy.
- Pair color with labels/icons. Include loading skeletons, empty states, partial results, missing telemetry, stale workflow revisions, revoked access, unavailable providers, expired evidence, and unsaved-state recovery.
- At wide desktop sizes show multiple candidate columns; at laptop sizes pin baseline plus the chosen candidate; on small screens compare two selectable candidates with stacked detail. Never shrink a many-column table into unreadable text.
- Keyboard users can select models, edit cases, launch, filter, open evidence, move between cases, and return to the invoking cell. Dialogs/panels have correct focus management; shortcuts do not interfere with text entry.
- Announce status changes without announcing every streamed token. Respect reduced motion, visible focus, zoom/reflow, and WCAG 2.2 AA contrast targets.
- Persist shareable filters, baseline, and selected case in URLs. Keep private display preferences local to the user. Links enforce workspace permissions.

## Score contract

Follow [scoring research](workflow-evaluation-scoring.md). Do not revive the unsupported 70/10/10/10 weights or universal token/tool/time targets.

The canonical score structure is `100 × weighted_mean_cases(mean_attempts(G × Q × E))`. `G` captures mandatory task checks; `Q` is calibrated quality in `[0,1]`; `E` is a bounded resource-efficiency function in `[0,1]` using task-specific references. Candidate failures contribute zero. Missing required evidence makes the affected result unscored and prevents a final comparable aggregate until resolved; provisional means must disclose coverage.

The exact resource penalty curve, references, weights, and eligibility thresholds are explicit policy data. Choosing their initial values is a calibration deliverable in phase 2, not a postponed user question or a claimed external standard. Validate them against reviewed reference runs and held-out cases before enabling a default recommendation. Include tokens and task tool calls as requested, with latency and cost accounted for by the declared policy. Check correlated penalties and show sensitivity of model rankings to plausible tradeoffs.

A workflow without calibrated references can run a pilot and receive quality and raw resource measurements, labeled Score calibration needed. It must not receive a fabricated authoritative composite. Once established, reference and policy revisions are immutable for an evaluation. Editing weights creates a what-if preview or new assessment revision, never mutates a published result.

Report success rate and repeatability separately. Aggregate attempts within cases before cases; include uncertainty from paired case-level comparisons. Recommendation eligibility additionally considers required quality/reliability constraints, complete coverage, and controlled execution. No universal repeat count or two-point winner margin is treated as a statistical standard.

## Engineering design

**Domain and persistence.** PostgreSQL stores versioned test sets, cases, scoring policies, evaluation drafts, frozen evaluation configurations, model candidates, planned attempts, leases, evidence indexes, assessments, and human reviews. Evidence payloads/artifacts use existing object storage with independent retention. Snapshot workflow graph, inputs, skill/runtime versions, permitted connections, model configuration, grader, and pricing identity. Regrading survives ordinary run/session cleanup. Credentials are referenced through authorized secret bindings, never embedded in snapshots or exports.

**Execution.** Extend WorkflowRun execution to accept an explicit model and frozen workflow configuration. Existing execution currently loads live workflow state and lacks the required model override. Use durable gateway worker patterns for leases, heartbeat, cancellation, idempotent launch, and recovery. Each attempt has an isolated agent/session/workspace and reproducible seed state. Environment preparation time is tracked separately from execution latency. Fixture/resettable tool state is preferred; live external execution is labeled uncontrolled and excluded from confident causal model recommendations. Source-agent authorization must be checked before provisioning and during relevant accesses.

**Evidence.** Capture final output/artifacts, validated end-state, canonical tool invocations, candidate usage, prices, and completion watermark. Separate required workflow protocol calls from task calls, preserve both counts, and avoid double-counting nested MCP spans. Usage from retries counts. Grader usage is separate. Address dropped observer batches and zero-filled missing usage before using them for model ranking. Attribute to workflow nodes through explicit instrumentation where feasible.

**Grading.** A separate version-pinned Node worker calls allowlisted Promptfoo assertions behind an AgentZ-owned contract. Validate direct trace injection, missing assertions, token accounting, and long-trajectory handling against the selected released artifact. Required state/artifact checks remain deterministic where possible. Model judges receive the necessary evidence and a fixed rubric; candidate output cannot alter evaluator instructions. Arbitrary uploaded code graders are outside this release. No additional hosted evaluation account is required.

**API and frontend.** Add scoped OpenAPI endpoints for case/policy revisions, draft/save, preview, launch, status/events, cancel, retry, comparisons, evidence, assessments, reviews, and exports. Generate clients using the existing flow. Use server-side pagination/filtering for histories and matrices, lazy-load evidence, and stream progress with reconnect/resume. Keep durable calculations on the server. Frontend uses existing Next.js, React, query, and UI conventions. CSV/JSON exports include configuration and policy versions; print styling supports a readable summary.

**Deployment.** Ship database migrations, worker image, RBAC, gateway permissions, Helm/Kustomize wiring, configuration, queue/worker metrics, retention cleanup, and documentation. Enforce organization/workspace boundaries on every read, launch, artifact, share link, and export. Metering limitations must be reflected in the review and live-budget UI.

## Delivery sequence and completion gates

| Phase | Deliverable | Gate |
|---|---|---|
| 1. UX prototype | Realistic clickable routes covering first-use, setup, progress, comparison, evidence, and failure states | Complete the journey from right-nav Workflows with keyboard and browser Back; review desktop, laptop, narrow, light, and dark layouts |
| 2. Scoring and adapter proof | Curated calibration cases, frozen reference runs, selected scoring policy, released Promptfoo contract tests | Human-reviewed rankings, sensitivity analysis, correct failure/missing-data semantics, candidate/grader usage separation |
| 3. End-to-end slice | Persist cases, run two models on one workflow, grade, show live progress and evidence | Isolated repeatable executions, valid score explanation, reload recovery, cancellation, source permissions |
| 4. Full comparison experience | Multi-case/model/repeat matrices, imports, baseline deltas, history, pairwise review, regrading, exports | Stable case alignment, preserved filters/focus, no silent reruns or rewritten history |
| 5. Release hardening | Deployment, telemetry reliability, scale, accessibility, fault recovery, regression tests | Cross-workspace denial, restart recovery, queue/cleanup correctness, visual/accessibility and browser journey checks |

These phases deliver one feature. The prototype is the first implementation artifact so usability problems are found before backend choices harden around them.

## Acceptance scenarios

1. Starting at Workflows in right navigation, a user reaches the selected workflow's Evaluations tab in one additional click, without selecting it again.
2. A user creates cases from past-run inputs or a validated import, compares permitted models, and launches entirely through the UI.
3. Launch review states the number of executions and all known budget assumptions. Duplicate launch requests do not create duplicate work.
4. Leaving, refreshing, reconnecting, or restarting a worker preserves progress and completed evidence.
5. A cheap incorrect run cannot win through efficiency. Missing tokens do not become free execution. Failed judges do not become model failures.
6. The results show a score, its explanation, component metrics, coverage, and uncertainty. Selecting a cell reveals the decisive evidence without losing comparison context.
7. Repeated attempts reveal inconsistent models. Regressions can be filtered and investigated without opening separate pages for every candidate.
8. Changing the comparison baseline does not change scores. Incompatible policy/dataset versions do not produce misleading improvement badges.
9. A reviewer can leave a judgment, create a regression case, regrade retained evidence, and export a reproducible report.
10. A representative first-time user can launch a pilot without assistance and identify the recommended model, a failing case, and its cause. Target task success at least 90% across a small moderated usability cohort, with all critical blockers fixed; report the cohort size rather than treating that percentage as a precise population estimate.
11. Validate a comparison with 1,000 cases, five candidates, and three attempts per case using paginated data and lazy evidence. Interaction targets are under 200 ms for local selection/filter input and under two seconds for the first comparison page on a documented test environment. These are product acceptance targets to measure, not current performance claims.

## Explicit boundaries

Ship workflow-scoped offline comparison, historical case import, repeated execution, explainable composite scores, human review, and regrading. Defer automatic production model switching, continuous production evaluation, arbitrary user code execution, per-node model search, automatic prompt optimization, and a separate general-purpose dataset platform. These do not block the complete user journey specified above.
