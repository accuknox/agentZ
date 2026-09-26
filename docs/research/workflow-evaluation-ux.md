# Workflow evaluation UX research

Research date: 2026-09-25. This is a primary-documentation review of Braintrust, LangSmith, Langfuse, and Phoenix. Behaviors below are **documented**, not verified in signed-in product sessions. Public documentation embeds screenshots and videos; direct attempts to fetch Braintrust's summary-table screenshot and LangSmith's baseline screenshot returned HTTP 403. No visual fidelity or interaction claims are based on those inaccessible assets. Recommendations are our design judgments, not claims that another product implements them.

## What the products document

### Braintrust

Comparison starts by selecting experiments and choosing Compare. A baseline creates per-case deltas and regression filters. The product offers aggregate summary tables, case tables, output diffs, and drilldown. Repeated trials can be grouped by input and expanded. Pairwise review records a preference and optional comment. Baselines can be persistent, but automatic baseline selection also exists. Default case matching uses input equality, with a configurable comparison key. [Comparison guide, including public screenshot references](https://www.braintrust.dev/docs/evaluate/compare-experiments)

Dataset creation supports uploading data, programmatic creation, and promoting production logs. The production-to-test-case path avoids requiring a user to start with a blank dataset. [Dataset creation](https://www.braintrust.dev/docs/annotate/datasets/create)

Its experiment interpretation view distinguishes application errors, scorer errors, non-errors, and unreviewed results. A row opens execution evidence; retrospective scoring can add evaluations without rerunning the application. [Interpretation guide](https://www.braintrust.dev/docs/evaluate/interpret-results)

**Adopt:** summary-to-case-to-evidence navigation, regression filters, expandable trials, explicit baseline. **Improve for our scope:** match stable case identities instead of raw input equality; require the selected baseline to remain visible; avoid introducing many competing table layouts in v1.

### LangSmith

An experiment shows input, actual output, reference output, evaluator feedback, cost, tokens, latency, and status. Users can hide/reorder columns, sort/filter, and choose compact/full/diff views. Row details contain the trace. Evaluator scores expose judge details and evaluator traces. Repetition summaries reveal individual trials. Progress tracks execution and evaluation separately. A dataset baseline pins to the top and supplies deltas to other experiments. [Analysis guide and screenshot references](https://docs.langchain.com/langsmith/analyze-an-experiment)

Comparison highlights improvements/regressions relative to a baseline and supports examining corresponding examples. [Comparison guide](https://docs.langchain.com/langsmith/compare-experiment-results)

Human review offers single-run and pairwise queues. Pairwise review shows two outputs and rubric choices A, B, or Equal, with comments and keyboard shortcuts. Queues also track reviewer progress. [Annotation queues](https://docs.langchain.com/langsmith/annotation-queues)

**Adopt:** distinguish execution progress from grading progress, visible reference outputs, one-click judge evidence, and a persistent baseline marker. **Defer:** team assignment, reservation rules, elaborate shared review queues, and highly configurable column systems until actual review volume requires them.

### Langfuse

Test cases can be entered manually, imported from CSV, or added from individual traces or batches of observations. Inputs and expected outputs are distinct fields; dataset edits create versions. [Datasets](https://langfuse.com/docs/evaluation/experiments/datasets)

The comparison guide requires checking compatible dataset and evaluator versions, examining both aggregates and regressions, and treating missing cases as missing rather than passing. It directs users from failing cases to application traces and human review, and recommends rescoring both sides after evaluator changes. It warns that selecting a UI baseline does not configure a CI gate. [Compare experiments](https://langfuse.com/docs/evaluation/experiments/compare-experiments)

UI experiments configure prompt, model connection, dataset, and optional evaluator. Crucially, this UI flow is for prompt experiments; full application logic runs via the SDK or a webhook-triggered external runner. We should not copy that prompt-only execution assumption for whole workflows. [UI experiments](https://langfuse.com/docs/evaluation/experiments/experiments-via-ui)

Annotation queues use configured score fields and keyboard navigation; they support comments and corrected outputs. [Annotation queues](https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues)

**Adopt:** reusable cases drawn from real runs, explicit comparability information, and differentiation between application and grader mistakes. **Improve:** keep the complete workflow configuration attached to the evaluation and explain it in product language rather than exposing SDK/webhook plumbing.

### Phoenix

Phoenix's onboarding starts from traces, finds problematic runs, converts them to datasets, iterates, then runs controlled experiments. Its own repository guide documents aggregate metrics, score distributions, per-example results, and task traces. [Quickstart](https://arize.com/docs/phoenix/quickstart), [maintained project guide](https://github.com/Arize-ai/phoenix/blob/main/docs/phoenix/skill.md)

Its release documentation confirms explicit baseline selection with per-case correct/incorrect transitions. A separate release note documents pagination in the comparison slideover and a repetition-number column shown only when relevant. [Baseline comparison](https://arize.com/docs/phoenix/release-notes/07-2025/07-09-2025-baseline-for-experiment-comparisons), [comparison pagination](https://arize.com/docs/phoenix/release-notes/10-2025/10-06-2025-paginate-compare-experiments)

**Adopt:** contextual run-to-case creation, comparison details without losing the result list, and displaying trial controls only when repetitions exist. Do not conflate Phoenix with Arize AX: AX annotation-queue documentation does not establish Phoenix behavior.

## Recommended journey for this application

The requested starting point is **Workflows in the RIGHT navigation**. Keep evaluations attached to a workflow, rather than introducing a competing top-level evaluation destination.

1. **Workflows → select workflow → Evaluations.** Use a workflow-level tab beside its existing detail areas. Show a primary “New evaluation” action, past evaluations with their state and score, and a plainly identified current comparison baseline. The first-run empty state explains the task: compare models using the same cases and scoring criteria.
2. **Set up a comparison.** Present a guided page with cases, models, scoring, and a final run summary. Prefer a page over a small modal: real workflow inputs, rubrics, and multiple models need room. Preserve the draft when navigating between sections.
3. **Build cases from real work.** Offer “Choose past runs” and “Add a case”; add file import when supported by the implementation plan. Copy inputs and source provenance, but require review before treating a historical answer as the expected answer. Show case names, inputs, expected outcomes or rubric criteria, and validation errors before running.
4. **Select models and explain scoring.** Show each candidate's resolved configuration and mark the reference model. Expose task quality, tools, tokens, and latency as separately named components underneath the single overall score. Include a concise explanation of the active policy and access to its reference/calibration evidence. Do not invent a preset's validity through a label such as “industry standard.”
5. **Review and start.** Summarize workflow revision, number of cases, models, repetitions, resulting execution count, scoring policy, and whether real tools or controlled fixtures will run. Show estimated spend only where credible, with judge spend separate. Otherwise say that cost is not yet estimated. Starting the evaluation begins an explicit batch operation.
6. **Monitor without trapping the user.** Show separate counts for queued/running/completed executions and pending/completed grading. Persist the evaluation so the user can leave and return. Partial rankings are labeled provisional. Provide stop/cancel according to supported runtime semantics, and report what already completed.
7. **Read the result.** Lead with a model comparison table containing overall score, quality, tool calls, tokens, latency, coverage, and deltas against the selected baseline. Show important failures beside the score. Use words/icons as well as color for better/worse/unscored. Provide filters for regressions, failed runs, grading errors, and missing measurements.
8. **Explain a result.** Selecting a model/case opens a detail drawer or full comparison page with the common input, expected outcome, baseline/candidate outputs, component scores, judge reasons, raw resource totals, and linked tool-call timeline. Trials expand under the same case. Preserve filters and scroll position on return.
9. **Close the loop.** Record human review separately from automated scores; allow a failing run to become a reusable case. Rerunning creates a new evaluation with visible ancestry. Rescoring records a new grading version without pretending the application ran again. Selecting a baseline is explicit and does not silently change the workflow's configured model.

## Design priorities and acceptance checks

- A first-time user can start from the right-hand Workflows navigation and prepare an evaluation without knowing framework names, SDK terms, or trace storage details.
- The interface always answers “What was compared?”, “Against which baseline?”, “Why this score?”, and “What failed?”
- The headline score never hides component values or coverage. A missing measurement renders as unavailable, never zero usage or a pass.
- Failed application execution, failed grading, cancellation, and incomplete work have distinct statuses and recovery actions. Retry only the intended failed stage; preserve the original attempt.
- All models use the same case version and scoring policy for a valid comparison. A mismatch is explained before displaying authoritative deltas.
- Tables remain usable with long outputs and many cases: summaries truncate, detail views reveal full values, and case lists paginate or virtualize.
- Keyboard focus, accessible labels, text status indicators, and return navigation work across setup, tables, filters, and detail panels.
- Keep v1 centered on setup, progress, comparison, and explanation. Do not expand it into a general observability or annotation-management product.
