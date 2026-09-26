# What agent benchmarks actually score

Researched 2026-09-25 against primary papers, official leaderboards, and scorer implementations. This document audits the scoring precedent behind workflow model selection. It does not implement a product scoring policy.

## Finding

There is no support in the benchmarks examined here for treating `70% quality + 10% tokens + 10% tools + 10% latency` as an industry standard. Most use task success or task-specific quality as the headline metric. Resource use is a separate measurement, an execution budget, or another axis in a cost/performance comparison.

Some benchmarks do combine metrics. The relevant distinction is **what they combine and why**. AgentBench normalizes performance across environments. ToolSandbox combines milestone completion with prohibited-state checks. Neither blends monetary cost, token count, tool calls, and quality with universal weights. These precedents support explicit task semantics, not a generic weighted score.

This review does not prove that no benchmark anywhere has a quality/efficiency composite. In particular, specialized action-efficiency benchmarks require separate examination. Their action definitions and reference baselines cannot automatically transfer to arbitrary workflow tools.

## Source checkouts

These shallow clones are in detached HEAD state. No dependencies were installed and no benchmark model calls were executed.

| Checkout | Commit | Files inspected |
| --- | --- | --- |
| `.ref/tau-bench` | `59a200c6d575d595120f1cb70fea53cef0632f6b` | `tau_bench/run.py`, `tau_bench/envs/base.py` |
| `.ref/ToolSandbox` | `c8571d7854316d2e1c5f288e59fe1e34e53f6dd1` | `tool_sandbox/common/evaluation.py` |
| `.ref/AgentBench` | `d1e4a10db08c87075c78972e48ecc182be03e2d5` | `src/analysis.py`; paper section 4.1 for overall formula |

SWE-bench, WebArena, OSWorld, Harbor, and GAIA scorer sources were read remotely. Pinned links appear below where commit identities were obtained. An initial attempt to clone the obsolete `princeton-nlp/hal-harness` URL failed; no HAL source-code claim here relies on that failed clone.

## Benchmark rules

### SWE-bench: full issue resolution

Let `F_i` be the proportion of designated fail-to-pass tests that pass after the patch and `P_i` the proportion of pass-to-pass tests that remain passing. The scorer marks full resolution when both equal 1:

```text
r_i = 1[F_i = 1 and P_i = 1]
% resolved = 100 × number of fully resolved instances / number of benchmark instances
```

The implementation also records partial resolution, but the headline is full resolution. Empty test categories return 1 in these helper functions, so the formula describes configured benchmark tests rather than every imaginable repository test. Tokens, cost, and tool-call counts are not inputs to this resolution calculation. [Pinned grading code](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/grading.py#L288), [official metric description](https://www.swebench.com/).

Product lesson: a workflow can have strict success criteria that combine accomplishing the change with preserving required existing behavior. This does not require an efficiency-weighted score.

### Terminal-Bench 2.0: outcome resolution under a time limit

The paper specifies tests of the final container state, not the commands or console output. The reported metric is average task resolution rate; experiments repeat each supported configuration at least five times. For a complete balanced matrix of N tasks and R trials, this is:

```text
resolution rate = (1/N) × Σ_i [(1/R) × Σ_j r_ij]
```

Time is an execution constraint. Cost and performance are analyzed with a Pareto frontier, and turns/tokens are analyzed separately. The paper therefore provides direct precedent for including efficiency in the comparison without blending it into the success score. [Paper, sections 2.1, 3, 4.1](https://arxiv.org/html/2601.11868v1).

Harbor's generic mean metric computes an arithmetic mean of reward values; it does not introduce a standard cost penalty. This general framework also supports other reward definitions, so its flexibility should not be confused with Terminal-Bench's particular task semantics. [Pinned mean implementation](https://github.com/laude-institute/harbor/blob/6cb9ff3167596c456e0b24622d473b59fc9ab6c7/src/harbor/metrics/mean.py).

Current leaderboard policy adds an integrity gate: detected reward hacking gives the trial reward 0. This is another success constraint, not a token-efficiency bonus. [Official integrity update](https://www.tbench.ai/news/leaderboard-integrity-update).

### τ-bench: state correctness and repeatability

The original checked-out scorer begins with reward 1, resets the environment, executes the reference actions, and compares the resulting database hash with the agent's final database hash. Required response snippets must also be present. Any failed required check makes reward 0. The reference trajectory creates the target state; it is not generally an exact tool-sequence requirement. [Pinned reward implementation](https://github.com/sierra-research/tau-bench/blob/59a200c6d575d595120f1cb70fea53cef0632f6b/tau_bench/envs/base.py#L124).

For N tasks, n trials per task, and c_i successful trials:

```text
average reward = mean of trial rewards
estimated pass^k = (1/N) × Σ_i [C(c_i, k) / C(n, k)]
```

`pass^k` measures all k selected attempts succeeding. It is different from `pass@k`, the at-least-one-success metric, whose corresponding estimator is `1 - C(n-c_i,k)/C(n,k)`. A configuration with one lucky success should not appear reliable under `pass^k`. The checked-out aggregation assumes a balanced trial matrix. [Pinned metric implementation](https://github.com/sierra-research/tau-bench/blob/59a200c6d575d595120f1cb70fea53cef0632f6b/tau_bench/run.py#L180), [paper](https://arxiv.org/abs/2406.12045).

Current successor documentation makes reward a product of components selected by `reward_basis`; default airline/retail/telecom grading uses database and communication checks. Exact action matching is optional and explicitly described as a strong assumption. [Successor evaluation docs](https://github.com/sierra-research/tau2-bench/blob/main/docs/evaluation.md).

### GAIA: normalized final-answer correctness

GAIA's official scorer returns a Boolean. Numeric references are compared after number normalization; lists require matching length and matching corresponding elements; ordinary strings are compared after normalization. The leaderboard divides the sum of correct answers by the expected size of the selected split:

```text
score = correct normalized answers / expected questions in split
```

Difficulty-level scores are also displayed. Neither the question scorer nor overall calculation uses trajectory length, tokens, or spend. [Official scorer](https://huggingface.co/spaces/gaia-benchmark/leaderboard/blob/main/scorer.py), [official aggregation in app.py](https://huggingface.co/spaces/gaia-benchmark/leaderboard/blob/main/app.py), [paper](https://arxiv.org/abs/2311.12983).

Product lesson: this is appropriate where there is a verifiable short answer, but insufficient by itself for a workflow whose intermediate actions or side effects matter.

### WebArena: conjunction of task outcome checks

The evaluator router selects configured string, URL, and/or HTML-content evaluators. `EvaluatorComb` multiplies their results:

```text
r_i = product of configured evaluator results for task i
overall score = mean of recorded task scores
```

For Boolean checks, the product is an AND requirement. The run script appends scores and computes their arithmetic mean. Tool count, token use, and cost do not enter this combination. [Pinned evaluator](https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/evaluation_harness/evaluators.py#L336), [pinned run aggregation](https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/run.py#L338).

The denominator is recorded scores in that implementation, so application code must separately decide how to expose infrastructure errors and incomplete coverage.

### OSWorld: execution-based task metrics

The official leaderboard presents success rate. Its environment returns the task's configured metric. For multiple metrics, the inspected implementation supports AND and OR policies: AND returns 0 immediately on a zero result, otherwise averages the results; OR returns 1 immediately on a one result, otherwise takes the maximum. With Boolean metrics these reduce to conjunction/disjunction; custom fractional metrics can yield partial scores. Infeasible tasks have a dedicated correct-failure branch.

This matters because describing every underlying OSWorld result as necessarily binary would overstate what its framework enforces. No generic resource penalty appears in the inspected evaluation function. [Pinned environment evaluator](https://github.com/xlang-ai/OSWorld/blob/b138d348256078fa634fc3b73567a7337c793e6b/desktop_env/desktop_env.py#L458), [official benchmark site](https://osworld-v1.xlang.ai/).

### AgentBench: an actual composite, across environments

AgentBench uses different task metrics across eight environments, including success rate, F1, reward, game progress, and step success. Section 4.1 defines:

```text
overall_m = (1/8) × Σ_e [s_me / μ_e]
```

Here `s_me` is model m's score in environment e and `μ_e` is the historical average across the evaluated model set. The paper freezes reciprocal averages as weights for later studies. Its table gives inverse weights `10.8, 13.0, 13.9, 12.0, 3.5, 13.0, 30.7, 11.6` when task scores are expressed on that table's scale. This overall score is not a percentage or a universal 0–100 utility score. [Paper section 4.1 and table 2](https://arxiv.org/html/2308.03688v3).

The checked-out analysis script extracts per-environment metrics and writes summaries; the paper is the authority inspected for the overall weighting formula. [Pinned analysis script](https://github.com/THUDM/AgentBench/blob/d1e4a10db08c87075c78972e48ecc182be03e2d5/src/analysis.py).

Product lesson: composites exist, but these weights balance environment difficulty. They do not establish a tradeoff between quality and resource consumption.

### ToolSandbox: milestones with a prohibited-state gate

The scorer finds the best mapping of milestones to trajectory snapshots subject to the milestone DAG's ordering constraints. It maximizes arithmetic mean milestone similarity. Final evaluation combines it with a minefield check:

```text
milestone score = max_valid_mapping mean(milestone similarities)
final score = 1[minefield similarity = 0] × milestone score
```

`turn_count` is a separate result field, not a term in that formula. When there are no milestones the default milestone score is 1; when there are no minefields the default minefield score is 0. [Pinned result formula](https://github.com/apple-aiml-research/ToolSandbox/blob/c8571d7854316d2e1c5f288e59fe1e34e53f6dd1/tool_sandbox/common/evaluation.py#L960), [pinned matching and defaults](https://github.com/apple-aiml-research/ToolSandbox/blob/c8571d7854316d2e1c5f288e59fe1e34e53f6dd1/tool_sandbox/common/evaluation.py#L1170).

Product lesson: this is a useful precedent for grading partial progress and prohibited intermediate actions while permitting different valid trajectories. It is not an efficiency score.

## What should change in the product proposal

The following are design recommendations from the evidence, not benchmark standards:

1. Remove the unexplained 70/10/10/10 default. Calling it customizable does not supply evidence for the default or make its implied tradeoffs valid.
2. Separate the **grading score** from the **model-selection policy**. The first measures task success/quality. The second decides what quality, cost, and latency tradeoffs are acceptable for this workflow.
3. Use `100 × mean(case mean trial success)` as a defensible headline when success is binary. For graded outputs, label a rubric-derived quality score explicitly and preserve rubric components. Neither is an all-purpose utility score.
4. Display monetary cost, latency, token categories, and tool-call counts alongside the score. Show quality/cost non-dominated candidates so the comparison identifies genuine tradeoffs instead of hiding them.
5. If the product must recommend one model automatically, use a declared policy such as lowest cost among candidates satisfying quality and latency requirements. This is our policy, not a claim of an industry-standard formula.
6. If a combined score remains a requirement, make the policy explicit, workflow-specific, and versioned. Specify normalization references and why a unit of efficiency can offset a quality loss. Test the score against human choices and perform sensitivity analysis before making it a default.
7. Treat token count and tool count as diagnostics unless there is a task-specific reason to optimize them directly. A cheaper call can consume more tokens; a necessary verification call can improve quality; one shell call can hide many operations.
8. Preserve valid alternative trajectories. Enforce exact sequences only for real workflow requirements. A no-op must not earn an attractive score merely because it is cheap.
9. Compare the same cases with repeated trials, report uncertainty, and distinguish model failure from scorer/infrastructure failure. Record completed/scored/planned coverage so changing denominators do not disguise unreliable execution.

The original desire for one number that captures all tradeoffs is a product preference. The research does not make it impossible, but it does require acknowledging that its utility function must come from the workflow's priorities rather than from Promptfoo or a generic benchmark.
