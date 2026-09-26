# Workflow run evaluations

Research date: 2026-09-25. Status: research and design recommendations, not an implementation specification.

Follow-up: [scoring research and corrections to the proposed formula](workflow-evaluation-scoring.md), [benchmark formulas](workflow-evaluation-benchmarks.md), and [framework scoring implementations](workflow-evaluation-framework-scoring.md).

## Recommendation

Use the existing workflow runner to execute candidate configurations and preserve their evidence. Evaluate those records through a replaceable grader adapter. Promptfoo is a credible first adapter because it exports independent assertions, supports custom providers, and already implements useful output and trajectory checks. Keep the product's definition of success, efficiency, aggregate score, and model recommendation outside the framework.

This recommendation originally followed source inspection. The subsequent implementation pins Promptfoo 0.123.1 and verifies exact-output and rubric assertions against its installed package. See [implementation and verification](../workflow-evaluations.md). Controlled inference fixtures validate integration; they do not establish judge calibration or real-model rankings.

## Reproducible references

| Project | Local checkout | Inspected revision | Package/runtime | License |
| --- | --- | --- | --- | --- |
| Promptfoo | `.ref/promptfoo` | `7110bef84da9bb48ae0d516ef5f4455b23cff82c` | package `0.123.1`; Node `>=22.22.0` | MIT |

The package version above is the value in the inspected commit. It is not a claim that an npm tarball with that version contains every inspected change. Before implementation, choose a released artifact, record its integrity hash, and rerun contract tests against that artifact. Online documentation can change independently of both the checkout and a release.

[Pinned package manifest](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/package.json), [pinned license](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/LICENSE).

## What an evaluation must establish

The question is which configuration performs this workflow well on representative inputs. A successful API call is insufficient. The evaluation needs a task outcome, output quality, resource consumption, and reliability across cases and repetitions.

Recommended evidence for each observation:

- Immutable workflow version, candidate model/configuration, dataset/case version, repetition index, run identifier and execution environment.
- Final output, resulting artifacts or external state, relevant tool inputs/results, and the full execution event record.
- Target input/output/reasoning/cache token counts where available, model and tool costs, end-to-end duration, tool attempts, failures, retries, and cancellation/timeout state.
- Evidence completeness. Missing telemetry is unknown, not zero consumption.
- Grader identity/version, rubric/configuration, scores with reasons, grader failures, and grading cost separately from target cost.

This is a proposed product contract. It is not a schema imposed by Promptfoo. Preserve enough original evidence to regrade a run without repeating its side effects.

## Promptfoo capabilities

Promptfoo's public package exports `evaluate`, provider loading, independent assertions, cache controls, guardrails, and red-team functionality. Custom providers can wrap an existing application. A provider returns `ProviderResponse` with output, token usage, cost, latency, metadata, and errors; its context includes test/evaluation identifiers, repeat index, and trace propagation. A provider call can receive an abort signal. These are suitable seams for evaluating a complete workflow rather than an isolated completion.

[Public exports](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/src/index.ts), [custom provider documentation](https://www.promptfoo.dev/docs/providers/custom-api/), [configuration reference](https://www.promptfoo.dev/docs/configuration/reference/).

Reusable assertions include deterministic output/schema checks, custom functions, rubric judging, factuality and retrieval checks. Trajectory checks cover tool use, arguments, ordering, step counts, error spans and durations. Assertion weights, named scores and custom scoring functions provide composition. These mechanics do not define which dimensions should determine the product's model recommendation.

[Assertion documentation](https://www.promptfoo.dev/docs/configuration/expected-outputs/), [trajectory handlers](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/src/assertions/trajectory.ts).

The runner provides test matrices, datasets, repetitions, concurrency, timeouts, progress and reporting. Tracing supports an OTLP receiver plus lookup from existing tracing services. The documentation covers Tempo, Braintrust and Langfuse and recognizes common tool attributes, including Vercel AI SDK telemetry.

[Test cases](https://www.promptfoo.dev/docs/configuration/test-cases/), [CLI](https://www.promptfoo.dev/docs/usage/command-line/), [tracing](https://www.promptfoo.dev/docs/tracing/).

## Source findings that affect correctness

### Independent grading works, but the batch documentation is misleading

The public `assertions.runAssertion()` accepts `providerResponse`, test/assertion context, `latencyMs`, `traceId` and `traceData`. It can evaluate recorded evidence without calling the target model. Supplied trace data enters assertion context only when a `traceId` is also present and the assertion needs trace context.

At the inspected commit, the batch method accepts assertions through `test.assert`, not a top-level `assertions` property. It does not accept a `traceData` parameter and instead loads traces from Promptfoo's trace store. The online Node API examples describe a different shape. Calling the real method without `test.assert` returns a passing result with score 1 and reason `No assertions`.

For product-owned traces, call the single assertion API and aggregate results in product code. Add a contract test that missing graders cannot become a perfect score. Do not copy the batch documentation example without checking the installed artifact.

[Assertion dispatch](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/src/assertions/index.ts#L754), [no-assertions behavior](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/src/assertions/assertionsResult.ts), [Node API documentation](https://www.promptfoo.dev/docs/usage/node-api-reference/).

### Precomputed output loses usage evidence

`test.providerOutput` bypasses the provider, but the evaluator constructs a response with empty token usage, cost 0, and `cached: false`. The evaluator also skips normal trace context generation for that route. It is a convenient text-grading path, not a complete historical-run import.

Use direct assertions or a replay provider that explicitly returns recorded metrics. A replay provider's lookup duration is not the historical workflow latency. The evaluator supports provider-reported `latencyMs`, which an adapter must populate correctly.

[Evaluator implementation](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/src/evaluator.ts#L920).

### Trajectory goal success uses a restricted summary

`trajectory:goal-success` sends final output and a compact trajectory summary to its judge. The summary retains step names, types and status. It omits tool argument/result payloads. It collapses consecutive steps with equal type/name/span name/status and then retains only the first 12 and last 12 compacted steps when more than 24 remain.

An important middle action can therefore disappear from grading context. The assertion cannot establish arbitrary artifact correctness or external-state success from this summary alone. Use deterministic state/artifact validators and a custom rubric with the evidence that matters to the task.

[Goal-success handler](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/src/assertions/trajectory.ts), [summary limits and implementation](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/src/assertions/trajectoryUtils.ts#L503).

### Tool-call F1 does not measure efficiency

`tool-call-f1` compares unordered sets of tool names extracted from output. It ignores call order and frequency. Repeating the same tool 100 times does not worsen this F1 when the name set is unchanged. It does not automatically inspect an entire workflow trace.

Use this check for tool selection only. Count attempted calls, completed calls and retries from execution evidence. Do not require an exact reference trajectory when several valid strategies can solve the task.

[Tool F1 source](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/src/assertions/toolCallF1.ts).

### Trace completeness and ordering need explicit policy

`trace-span-duration` throws when trace data is absent, but returns a passing score when no matching spans contain complete timing. Pair duration checks with required span presence and evidence-completeness checks.

Trajectory extraction sorts spans by start time, then end time, then original position. This is not a concurrency-aware partial-order comparison. Shell tools such as `exec_command`, `local_shell` and `shell` can normalize to `command` instead of `tool`. Counting only `type=tool` can omit shell actions.

[Duration handler](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/src/assertions/traceSpanDuration.ts), [normalization](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/src/assertions/trajectoryUtils.ts#L315).

### Default aggregation can hide important failures

Cost and latency assertions return binary scores at configured thresholds. They do not provide a continuous efficiency metric. Assertion aggregation uses a weighted arithmetic mean. Without a test threshold, individual assertion failures determine failure; a numeric test threshold overrides that rule using the aggregate score. Threshold 0 can allow failed assertions to coexist with a passing test.

`assertScoringFunction` can implement quality gates and nonlinear formulas. Its `tokensUsed` context represents grading usage accumulated from assertion results, not target workflow usage. Candidate-efficiency calculations must use the recorded target metrics instead.

[Cost](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/src/assertions/cost.ts), [latency](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/src/assertions/latency.ts), [aggregation](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/src/assertions/assertionsResult.ts).

## Integration alternatives

| Approach | What it reuses | What remains product-owned | Assessment |
| --- | --- | --- | --- |
| Promptfoo runs custom workflow providers | Matrices, cases, repetitions, reports, traces | Durable execution, state isolation, approvals, cancellation, budgets | Useful for engineering experiments; avoid competing run records |
| Product runs workflows; Promptfoo grades records | Assertions, model judges, reasons | Experiment scheduling, evidence, aggregation, comparison UI | Preferred product architecture |
| Recorded-run replay provider | Promptfoo reports with recorded response metadata | Historical metric and trace fidelity | Useful secondary export/inspection route |
| `providerOutput` | Simple text regrading | All non-output evidence | Unsuitable as the full evaluation integration |

These are design recommendations based on the APIs and implementation cited above. A framework cannot make live tool executions repeatable or roll back their effects without application support.

## Scoring and experiment design

The following are proposed defaults to discuss with the product owner, not a finalized formula.

1. Establish task success and quality before rewarding efficiency. An empty response with no tool calls must not win.
2. Retain component scores and raw resource metrics beside the headline score. Version the scoring policy.
3. Use fixed case-specific budgets or reference anchors when normalizing efficiency. Cohort min-max normalization changes existing scores whenever another candidate is added.
4. Avoid heavily weighting both tokens and dollars without an explicit reason. They often measure overlapping expense. Tool calls also differ in cost and usefulness.
5. Keep target cost and grader cost separate. Report both when budgeting an experiment.
6. Use the same case set and initial environment for each candidate. Reset state or use fixtures where tools mutate external state.
7. Preserve repeated observations. Report task success rate, score distribution, resource distributions and uncertainty instead of only an average.
8. Separate failed target execution from failed grading and incomplete evidence. A judge timeout should not silently become a low-quality model answer.
9. Calibrate judges against human-reviewed examples. A rubric is an executable measurement policy and needs regression cases.
10. Freeze or identify dataset, workflow, candidate configuration, grader and pricing versions so later scores remain interpretable.

Promptfoo's per-test repeat setting overrides the global repeat count. Repeat indexes use separate cache entries; disable caching when each sample must invoke the provider. Cached responses cannot establish live latency. The product should distinguish repeat sampling, infrastructure retries, tool retries and model self-correction.

[Repetition and cache behavior](https://www.promptfoo.dev/docs/configuration/test-cases/), [latency implementation](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/src/assertions/latency.ts).

The research did not establish that arbitrary custom-provider exceptions are retried or that all failed-attempt usage is captured. Verify those behaviors with the chosen adapter. Framework timeout/concurrency options do not establish dollar limits or roll back side effects.

## Runtime, licensing and data handling

The inspected core repository is MIT licensed. Preserve its notice when distributing substantial portions. This statement covers the inspected core license, not all transitive dependencies, model-provider terms, or hosted commercial services. Check those separately for the chosen deployment.

The package imports broad evaluation, provider, database, server and telemetry functionality and requires Node >=22.22.0 at the inspected revision. A separate version-pinned evaluator worker limits runtime/dependency conflicts and gives one place to control outbound requests. Its interface should accept product-owned evidence and return product-owned scores rather than leaking Promptfoo types throughout the application.

[License](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/LICENSE), [dependencies and runtime](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/package.json).

Promptfoo documents usage telemetry enabled by default. `PROMPTFOO_DISABLE_TELEMETRY=1` disables it and `PROMPTFOO_DISABLE_UPDATE=1` disables update checks. The documentation says telemetry excludes prompts, outputs, test cases and API keys, but can include configured account identity. Disable optional telemetry and sharing explicitly in an embedded evaluator. Model-backed judges still send their evaluation context to the configured provider.

[Telemetry documentation](https://www.promptfoo.dev/docs/configuration/telemetry/).

Trace display/export redaction does not guarantee secrets are absent from raw local storage. Redact before persistence where required. Arbitrary JavaScript/Python assertions and provider files execute code; they are not a safe configuration language for untrusted users. Prefer a constrained product configuration or isolate execution.

[Tracing storage/redaction documentation](https://www.promptfoo.dev/docs/tracing/), [JavaScript assertion implementation](https://github.com/promptfoo/promptfoo/blob/7110bef84da9bb48ae0d516ef5f4455b23cff82c/src/assertions/javascript.ts).

`agent-rubric` can inspect artifacts through coding-agent providers. Its default Codex configuration is read-only in an isolated temporary directory. Giving it workspace/tool/network access expands its capabilities and side effects. Start with deterministic artifact checks and ordinary rubric grading unless evidence gathering requires an agent.

[Agent rubric documentation](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/agent-rubric/).

## Required feasibility checks

Before committing to an integration, test the actual pinned package artifact with:

- A recorded successful run, failed run and empty output, without calling the target provider.
- Missing assertions and missing usage/trace data, confirming neither becomes a perfect score or zero consumption.
- Direct trace injection with `traceId`; batch behavior against `test.assert`.
- Long trajectories with decisive middle evidence and shell/tool normalization.
- Repeated calls to one tool, confirming the separate efficiency metric detects waste even when tool F1 remains unchanged.
- A trace duration check with no matching timed spans.
- Target metrics distinct from grader token usage and grader cost.
- Cache hits, fresh repeats, timeout/cancellation, partial traces and delayed trace completion.
- Two concurrent experiments with distinct configurations and cache namespaces.
- A rubric failure or provider outage, confirming it remains a grading error.
- Quality gates that cannot be compensated by resource savings.

These tests have not been run. They address observed source behavior and integration risks rather than restating a proposed implementation.

## Decisions for the design interview

Ask these after research, one question at a time:

- Does a candidate replace one model throughout the workflow or define models per node?
- Which observable artifact or external state proves task success?
- Can an incorrect cheap result ever outrank a correct expensive result?
- Are evaluation tools live, sandboxed, recorded/replayed, or mixed?
- Who authors representative cases and expected results?
- Which resource is the real constraint: dollars, latency, tokens, tool load, or reliability?
- How should missing evidence affect eligibility and displayed scores?
- Is the result advisory, or may it change production model configuration?

No final feature plan or scoring formula is justified until these decisions are settled.
