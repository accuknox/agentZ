# How evaluation frameworks actually calculate scores

Research date: 2026-09-25. This audit checks formulas and failure semantics against implementation, not framework marketing. No dependencies were installed and no paid model evaluations were run.

## Finding

**None of the examined frameworks establishes a 70% quality / 10% tools / 10% tokens / 10% latency industry default.** Weighted aggregation is common; choosing those dimensions, weights, normalization functions, and failure rules is application policy. The distinction matters: a library supporting weighted scores is not evidence for any particular weights.

There are three different operations often called “aggregation”:

1. Construct one metric from its evidence, such as factual correctness from precision and recall.
2. Combine different metrics into a utility score, such as quality versus cost.
3. Average the same metric across examples or repeated runs.

Most default averages below implement operation 3. DeepEval's GEval probability weighting implements operation 1. Neither justifies operation 2's business tradeoffs.

## Reproducible source snapshots

Cloned with `git clone --depth 1 --filter=blob:none` into `.ref/`; the recorded revisions are the exact inspected HEADs. Links below pin source to those revisions.

| Project | Local checkout | Revision |
|---|---|---|
| DeepEval | `.ref/deepeval` | `7e94626702befc558c718e1edb18408e094c4bed` |
| Ragas | `.ref/ragas` | `298b68274234c060deacab3cf5fb52aa3a20e885` |
| Inspect AI | `.ref/inspect_ai` | `f7180f50c09744ad1ee62b8e181beb2171452aa9` |
| Braintrust SDK | Remote source read; not cloned in this audit | `cc165a4843805b531645ddb1d27969204aab9ade` |

## DeepEval: rubric scores, branching decisions, and separate thresholds

### GEval

Given retained candidate score tokens `k` with probabilities `p_k`, the logprob path calculates:

`g = sum(k * p_k) / sum(p_k)`

It discards nondecimal tokens and tokens with probability below 0.01, and finds the final occurrence of the emitted raw-score token. If no probability mass survives, it returns the raw score. These weights describe the judge's distribution over possible score labels. They are **not weights for accuracy, tools, cost, or latency**. [Probability implementation](https://github.com/confident-ai/deepeval/blob/7e94626702befc558c718e1edb18408e094c4bed/deepeval/metrics/g_eval/utils.py#L337)

The normal score is `(g - lower) / (upper - lower)`. The default range is 0–10; a supplied rubric can set a different range within it. Strict mode uses the integer binary judge result instead. The raw-score fallback is used when a custom model does not implement raw responses with logprobs. [Normalization](https://github.com/confident-ai/deepeval/blob/7e94626702befc558c718e1edb18408e094c4bed/deepeval/metrics/g_eval/g_eval.py#L147), [range](https://github.com/confident-ai/deepeval/blob/7e94626702befc558c718e1edb18408e094c4bed/deepeval/metrics/g_eval/utils.py#L402), [model fallback documentation](https://deepeval.com/docs/metrics-llm-evals)

### DAGMetric

A matching terminal verdict supplies `score = terminal_score / 10`. A terminal child metric instead supplies its own score. The graph's author controls branch criteria and terminal values; the runner does not average all graph nodes into an overall quality/resource mixture. The branching graph can encode prerequisites before awarding a high score, but its branch judgments can still use a model. [Runner](https://github.com/confident-ai/deepeval/blob/7e94626702befc558c718e1edb18408e094c4bed/deepeval/metrics/dag/runner.py#L65)

### Task completion and step efficiency

In the ordinary LLM mode, task completion returns the judge's alignment verdict. Strict mode turns a result below its threshold into zero. Step efficiency similarly returns a judge verdict after extracting the task from the trace. Neither computes a ratio from actual dollars or token counters. [Task completion](https://github.com/confident-ai/deepeval/blob/7e94626702befc558c718e1edb18408e094c4bed/deepeval/metrics/task_completion/task_completion.py#L333), [step efficiency](https://github.com/confident-ai/deepeval/blob/7e94626702befc558c718e1edb18408e094c4bed/deepeval/metrics/step_efficiency/step_efficiency.py#L119)

The efficiency prompt is unusually strict. It asks the judge to penalize speculative or unnecessary steps and assume doubtful steps were unnecessary. Its rubric is a design opinion, not an observed mathematical optimum. It explicitly excludes output correctness from this metric. That makes it unsuitable as the only ranking criterion and potentially unsuitable for workflows where verification or exploration is desirable. [Actual judge prompt](https://github.com/confident-ai/deepeval/blob/7e94626702befc558c718e1edb18408e094c4bed/deepeval/metrics/step_efficiency/templates/get_execution_efficiency.txt)

The experimental System One mode uses different calculations. Its task-completion and step-efficiency templates each define three within-metric questions, with weights 2, 1, 1, so their mapped answers give `(2*a + b + c)/4`. This is another real weighted composite, but its dimensions are questions about one construct, not the proposed four product dimensions. Changing evaluation mode changes score meaning. [Task questions](https://github.com/confident-ai/deepeval/blob/7e94626702befc558c718e1edb18408e094c4bed/deepeval/metrics/task_completion/templates/_experimental_system_one_questions.txt), [efficiency questions](https://github.com/confident-ai/deepeval/blob/7e94626702befc558c718e1edb18408e094c4bed/deepeval/metrics/step_efficiency/templates/_experimental_system_one_questions.txt), [mapping contract](https://github.com/confident-ai/deepeval/blob/7e94626702befc558c718e1edb18408e094c4bed/deepeval/metrics/utils/system_one.py)

### Thresholds and missing/error outcomes

The ordinary pass decision is `score >= threshold`. The common constructor default is 0.5, but that is an individual metric's pass threshold, not a recommended overall quality floor. `threshold=None` makes success `None`, supporting score-only evaluation. Strict mode changes scoring behavior as well as threshold. A recorded metric error causes unsuccessful status when a threshold is active. [Base metric](https://github.com/confident-ai/deepeval/blob/7e94626702befc558c718e1edb18408e094c4bed/deepeval/metrics/base_metric.py#L172)

Evaluation's `ignore_errors` and `skip_on_missing_params` both default to false. These are explicit error-policy controls, not evidence that unknown measurements should count as zero or be silently discarded. [Error configuration](https://github.com/confident-ai/deepeval/blob/7e94626702befc558c718e1edb18408e094c4bed/deepeval/evaluate/configs.py#L44)

## Ragas: metric-specific formulas and NaN-aware means

### AnswerCorrectness has actual default weights, for a different purpose

The legacy `AnswerCorrectness` implementation sets weights `[0.75, 0.25]` for factuality and semantic similarity:

`correctness = (w_f * F_beta + w_s * similarity) / (w_f + w_s)`

`F_beta = (1 + beta^2) * precision * recall / (beta^2 * precision + recall)`

Here precision and recall come from judge-classified factual statements, with default `beta=1`. This 75/25 choice combines two estimates of answer correctness. It says nothing about the value of correctness relative to token use. Nonnegative weights are required and all-zero weights are rejected. A failed statement judgment can return NaN. [Implementation and defaults](https://github.com/vibrantlabsai/ragas/blob/298b68274234c060deacab3cf5fb52aa3a20e885/src/ragas/metrics/_answer_correctness.py#L141), [F-beta](https://github.com/vibrantlabsai/ragas/blob/298b68274234c060deacab3cf5fb52aa3a20e885/src/ragas/metrics/utils.py)

### Tool metrics measure reference agreement, not general efficiency

`ToolCallF1 = 2*precision*recall/(precision+recall)`, with the implementation's empty-case handling. Actual and expected calls become sets of name/argument pairs, so repeated identical calls disappear. It cannot detect repeated identical wasted calls. [Implementation](https://github.com/vibrantlabsai/ragas/blob/298b68274234c060deacab3cf5fb52aa3a20e885/src/ragas/metrics/collections/tool_call_f1/metric.py#L90)

`ToolCallAccuracy` averages matching argument scores over the reference count, applies a coverage penalty when predictions are shorter, and multiplies by a binary full tool-name-sequence agreement indicator. Flexible ordering compares sorted sequences. An extra or missing call therefore makes the final score zero despite partial argument matches. Both lists empty returns one; only one empty returns zero. [Implementation](https://github.com/vibrantlabsai/ragas/blob/298b68274234c060deacab3cf5fb52aa3a20e885/src/ragas/metrics/collections/tool_call_accuracy/metric.py#L89)

### Dataset aggregation and errors

`EvaluationResult` calculates a separate NaN-aware arithmetic mean for each metric. It does not automatically average different metric columns into one headline number. With `raise_exceptions=False`, the default, metric failures can produce NaN. `safe_nanmean` excludes NaNs and returns NaN for empty/all-NaN input. [Dataset result](https://github.com/vibrantlabsai/ragas/blob/298b68274234c060deacab3cf5fb52aa3a20e885/src/ragas/dataset_schema.py#L434), [NaN mean](https://github.com/vibrantlabsai/ragas/blob/298b68274234c060deacab3cf5fb52aa3a20e885/src/ragas/utils.py#L46), [evaluation API](https://github.com/vibrantlabsai/ragas/blob/298b68274234c060deacab3cf5fb52aa3a20e885/src/ragas/evaluation.py#L390)

Implication: a displayed high mean can represent a smaller valid subset. The product must retain the scored count, failed count, and intended denominator.

## Inspect AI: repeated-trial reduction and task metrics

Inspect keeps scorer outputs separate from metrics that summarize them. The default epoch reducer is mean. For scalar results, it averages valid repetition scores for each sample; then the chosen metric aggregates sample scores. This is averaging the same measure across observations, not trading quality for efficiency. Alternative reducers include majority/mode and success estimators. [Reducer selection](https://github.com/UKGovernmentBEIS/inspect_ai/blob/f7180f50c09744ad1ee62b8e181beb2171452aa9/src/inspect_ai/_eval/task/results.py#L370), [reducers](https://github.com/UKGovernmentBEIS/inspect_ai/blob/f7180f50c09744ad1ee62b8e181beb2171452aa9/src/inspect_ai/scorer/_reducer/reducer.py#L85)

The built-in mean maps correct to 1, incorrect to 0, partial to 0.5, and no-answer to 0, while numeric scores pass through. It does not constrain every custom metric to 0–1 or choose an application threshold. [Mean implementation](https://github.com/UKGovernmentBEIS/inspect_ai/blob/f7180f50c09744ad1ee62b8e181beb2171452aa9/src/inspect_ai/scorer/_metrics/mean.py)

`Score.unscored()` is a NaN sentinel with a reason. Evaluation aggregation excludes root-level NaNs and records scored/unscored counts. Although calling `mean([])` directly returns zero, the experiment results layer synthesizes NaN for an empty scalar metric, so “nothing was scored” should not be reported as a genuine zero-quality experiment. [Unscored score](https://github.com/UKGovernmentBEIS/inspect_ai/blob/f7180f50c09744ad1ee62b8e181beb2171452aa9/src/inspect_ai/scorer/_metric.py#L158), [filter/count logic](https://github.com/UKGovernmentBEIS/inspect_ai/blob/f7180f50c09744ad1ee62b8e181beb2171452aa9/src/inspect_ai/_eval/task/results.py#L405), [empty result policy](https://github.com/UKGovernmentBEIS/inspect_ai/blob/f7180f50c09744ad1ee62b8e181beb2171452aa9/src/inspect_ai/_eval/task/results.py#L615)

This is useful precedent for explicitly representing unscorable outcomes. It does not imply task failures should be excluded: a model's failed task can correctly be scored zero, while a broken grader is unscored.

## Braintrust: customizable composites and explicit missing-score handling

The platform offers weighted average, minimum, or maximum aggregate scores. Users choose the included scores and weights. Its documentation does not prescribe a default quality/tool/token/latency mixture or specify enough detail to infer proprietary platform null-handling. [Aggregate score configuration](https://www.braintrust.dev/docs/admin/projects#create-aggregate-scores)

The open TypeScript SDK's local summary is directly auditable. For each named score, it computes `sum(valid scores)/count(valid scores)` and skips null/undefined. If a scorer returns null, it produces no result. An exported `defaultErrorScoreHandler` assigns zero to unhandled scores, but the execution path invokes an error handler only when one was supplied in evaluator configuration. The helper's name does not prove that every scorer error automatically becomes zero. [Null scorer behavior](https://github.com/braintrustdata/braintrust-sdk/blob/cc165a4843805b531645ddb1d27969204aab9ade/js/src/framework.ts#L1047), [zero-on-error helper](https://github.com/braintrustdata/braintrust-sdk/blob/cc165a4843805b531645ddb1d27969204aab9ade/js/src/framework.ts#L1245), [conditional invocation](https://github.com/braintrustdata/braintrust-sdk/blob/cc165a4843805b531645ddb1d27969204aab9ade/js/src/framework.ts#L1570), [local summary](https://github.com/braintrustdata/braintrust-sdk/blob/cc165a4843805b531645ddb1d27969204aab9ade/js/src/framework.ts#L1790)

## Recommended changes to the proposed feature

These are design recommendations inferred from the audited practice, not standardized formulas supplied by these libraries.

1. Remove any claim that 70/10/10/10 is an established evaluation default. If retained as an initial preset, label it an uncalibrated product choice and version it.
2. Separate task-quality scoring from resource measurement. Use reference/rubric judges for quality, and runtime counters for tokens, tool calls, time, and cost. A model should not estimate a counter we already have.
3. Make successful completion or critical correctness a prerequisite for an efficiency recommendation. Simple weighted sums otherwise allow cheap failures to compensate for poor quality.
4. Keep the metric vector visible even when a scalar score is required. Persist the component scores, raw resource counters, formula version, thresholds, and weights so the headline can be reproduced.
5. Specify normalization before weights. `0.1 * latency_score` has no interpretable meaning until the transformation from seconds to score is defined. Normalize against fixed per-workflow budgets or baselines, not the changing candidate set, if historical scores must remain comparable.
6. Calibrate tradeoffs from concrete acceptable exchanges on representative cases. For example, determine whether losing a given amount of task quality is acceptable for a given cost reduction. Library defaults cannot answer that business question.
7. Report per-case means across repetitions, then aggregate across cases with explicit case weights. Preserve reliability and uncertainty; do not substitute best-of-N for expected single-run performance unless production also gets N attempts.
8. Distinguish task failure, infrastructure failure, grader failure, absent telemetry, and valid zero. Never silently turn missing token usage into zero-token efficiency. Report coverage; rerun infrastructure/grader failures or withhold the combined score when required evidence is missing.
9. If a concrete combined scalar must be designed before calibration, use an explicitly provisional, configurable formula with quality gating and monotone resource penalties. Do not present its constants as research findings. An alternative research-supported starting point is quality qualification followed by comparison of measured resource use, with a composite added after tradeoffs are agreed.

A framework can supply grading mechanics, repeated-run orchestration, and standard summaries. The workflow's acceptance criteria and value assigned to resource savings remain product decisions.
