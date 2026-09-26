# Workflow evaluation scoring research

Research date: 2026-09-25. This note revises the scoring portion of the proposed feature plan. No product implementation or live model experiment was performed.

## Conclusion

The proposed 70% quality, 10% tokens, 10% tools, 10% latency formula is a product hypothesis, not an industry standard. The reviewed benchmarks and frameworks do not establish universal weights for those dimensions. Remove those defaults and the arbitrary 20,000-token, 25-tool, 120-second normalization targets from the implementation plan pending calibration.

The evidence supports independently measured outcome quality, trajectory correctness, reliability, and resource use. A single score can express a workflow owner's tradeoffs, but its policy must be explicit, versioned, and checked against representative tasks. Installing Promptfoo does not solve that policy decision.

Related source audits:

- [Promptfoo integration and framework selection](workflow-evaluations.md)
- [Benchmark formulas](workflow-evaluation-benchmarks.md)
- [Framework scoring implementations](workflow-evaluation-framework-scoring.md)

## What existing evaluations do

| Evaluation | Scoring approach | Implication for this feature |
|---|---|---|
| SWE-bench, WebArena, GAIA | Task outcome or answer correctness; see benchmark audit | Prefer verifiable end states over asking a judge whether a run looks successful |
| tau-bench | Repeated-run reliability through pass^k | A good average score can conceal inconsistent execution |
| ToolSandbox | Milestone similarity constrained by state dependencies and forbidden events | Judge intermediate states and forbidden actions, not just final text |
| AgentBench | Average environment performance after scaling by fixed historical environment baselines | Normalization across tasks is a different decision from valuing resources |
| HELM Capabilities v1 | Mean capability scores, with the 1–10 WildBench scale mapped to 0–1 | Aggregate comparable quality measures; avoid scores that change merely because competitors change |
| HAL | Cost-controlled agent evaluations with inspectable traces | Compare quality at known resource expenditure |
| Artificial Analysis | Intelligence, cost per task, time per task, and tokens per task reported as distinct measures | Preserve the resource breakdown even when presenting one product score |
| Habitat SPL | Success multiplied by shortest-path efficiency | Efficiency has a meaningful task-specific reference and failure earns zero |
| ARC-AGI-3 | Completion and action efficiency relative to human play | A composite can work when the action unit and reference baseline are carefully defined |

HELM's authors explicitly replaced mean win rate because it depended on the comparison cohort and small score changes could invert ranks. Their replacement averages quality across scenarios, not quality plus resource consumption. [HELM methodology](https://crfm.stanford.edu/2025/03/20/helm-capabilities.html)

HAL emphasizes cost-controlled agent evaluation and reproducible traces. Artificial Analysis distinguishes capability from resource measures and notes tokenizer differences. These are useful precedents for a model-selection interface that shows tradeoffs. [HAL](https://hal.cs.princeton.edu/about), [Artificial Analysis methodology](https://artificialanalysis.ai/methodology)

The research paper *AI Agents That Matter* motivates jointly optimizing cost and accuracy and distinguishes model benchmarking from downstream application selection. It does not supply universal weights for all applications. [Paper](https://arxiv.org/abs/2407.01502)

### Composite-score precedents

Habitat's success-weighted path length uses:

```text
SPL = mean_i(success_i * shortest_path_i / max(shortest_path_i, actual_path_i))
```

Here the denominator measures the same physical quantity as the reference. An optimal path is meaningful for navigation. There is generally no known optimal token count for an arbitrary workflow. [Habitat docs](https://aihabitat.org/docs/habitat-lab/habitat.tasks.nav.nav.SPL.html), [implementation](https://github.com/facebookresearch/habitat-lab/blob/main/habitat-lab/habitat/tasks/nav/nav.py), [original evaluation paper](https://arxiv.org/abs/1807.06757)

ARC-AGI-3's inspected methodology assigns a completed level `min(1.15, (human_actions / agent_actions)^2)` and an incomplete level zero. It weights levels by their level number, caps the game score by weighted completion, and averages games. The reference is the upper median action count from controlled first-time human play. Only interactions affecting the environment count as actions; internal operations are excluded. This is a domain-specific completion/efficiency metric, not an LLM token/tool formula. Source cloned into `.ref/arcprize-docs` at `6956cde0c84b9b077d31ae98e5a9a243622a2553`. [Pinned methodology](https://github.com/arcprize/docs/blob/6956cde0c84b9b077d31ae98e5a9a243622a2553/methodology.mdx)

## Problems with the initial formula

1. **Unjustified tradeoffs.** With the proposed weights and both runs passing the gate, quality 1.0 and all efficiency scores 0.2 produces 76; quality 0.8 and all efficiency scores 1.0 produces 86. That ranking may be desired in some workflows, but it is not a neutral consequence of industry practice.
2. **Arbitrary normalization.** A 25-call target has different meaning for a short lookup and a long verification workflow. A target is not evidence of the minimum necessary calls.
3. **A plateau below the target.** `min(1, target / actual)` cannot distinguish 5 from 20 calls when the target is 25. It expresses meeting a budget, not minimizing resource use.
4. **Overlapping penalties.** Token use, money, latency, and tool calls often correlate. Weighting all four can penalize the same behavior repeatedly. They can still represent distinct preferences, but that must be deliberate.
5. **Misleading units.** Native tokens differ by tokenizer; cached, input, output, and reasoning tokens differ in accounting. Tool counts depend on tool granularity. Raw observations need definitions before normalization.
6. **Quality scale assumptions.** A judge's 0.8 does not automatically mean 80% success or cardinal utility. Define anchored rubrics and test agreement with human judgments.
7. **Unsupported certainty.** Three repeats, 20 cases, a 95% observed success gate, and a two-point winner margin are proposed settings, not universal standards. Sample requirements depend on observed variance, failure rates, and the decision's stakes.

## Revised scoring plan

Keep the requirement for a single 0–100 workflow score, with its quality, reliability, token, tool, latency, and monetary measurements visible beside it. The score is comparable only under the same suite revision and scoring policy.

Separate collection, grading, and aggregation:

- Collect raw candidate usage independently of judge usage. Retain native token categories, task tool invocations, required protocol calls, retries, elapsed execution time, and priced cost with provenance. Canonicalize duplicate trace spans before counting calls.
- Grade deterministic assertions and final environment state wherever possible. Use calibrated rubric judges for subjective outputs and trajectory checks where sequence or intermediate state matters.
- Record task failure as failure, including a timeout caused by the candidate. Record missing evidence, grader failure, and infrastructure failure separately. Do not silently drop failed tasks or treat missing usage as zero.
- Aggregate repeated trials within a case before aggregating cases. Preserve task categories and declared case weights. Report uncertainty and paired differences across the same cases; avoid claiming a winner based only on rounded scores.

Support two explicit policy families in the design. These are proposed product policies, not claimed standards:

**Quality within budgets.** Score average validated quality for runs that satisfy mandatory requirements and declared resource budgets, with unsuccessful or over-budget runs contributing zero. This answers how well the model performs under operational limits, but intentionally does not reward every reduction below those limits.

**Reference-adjusted workflow score.** For workflows that need continuous efficiency ranking, use a success/quality score reduced by resource penalties relative to frozen, case-specific reference runs. A candidate form to investigate is `100 * mean_cases(mean_trials(gate * quality * efficiency))`, where efficiency is bounded in `[0,1]`. This resembles success-weighted efficiency in structure only. Its resource normalization, penalty functions, and weights require calibration; the literature does not determine them for AgentZ. Do not choose a geometric mean, reciprocal curve, or exponent solely because it looks mathematically tidy.

For the requested feature, investigate the second policy using the first as a simple comparison baseline. Decide the final curve from reference runs and judgments of acceptable quality/resource tradeoffs. Freeze it before evaluating held-out candidates. A cheaper incorrect result must not earn resource bonuses. Lower resource use at unchanged quality must not reduce the score. A failed measurement must not improve a model's ranking.

Always show quality/resource plots and models for which no competitor is both better and cheaper. A scalar compresses these tradeoffs; the breakdown lets users see what the compression hides.

## Required validation before committing to defaults

1. Assemble representative cases across short and long workflows, including failures, retries, required validation calls, and alternate valid tool strategies.
2. Establish task success checks and human-reviewed quality anchors. Measure judge disagreement on the same evidence.
3. Collect reference runs using frozen workflow/runtime/tool configurations. Establish meaningful per-case resource references and distinguish them from hard operational limits.
4. Compare candidate scoring policies against reviewed model preferences. Stress-test rankings across plausible weights and baselines, including the 76-versus-86 example above.
5. Verify mathematical and data properties: no reward for failed work, no hidden missing-data advantage, monotonic resource penalties, stability when a competitor is added, and transparent accounting for retries and grading overhead.
6. Evaluate ranking stability on held-out cases and repeated runs. Choose confidence reporting and practical significance thresholds based on this evidence, not a universal sample-count rule.

This research validates design principles and identifies source behavior. It does not empirically validate a final AgentZ scoring formula. The next implementation plan must include that calibration work before presenting any default score as a reliable model recommendation.
