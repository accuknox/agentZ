# Workflow evaluation performance audit

Baseline: `5dd88f99`. Pre-feature comparison: `34a7fc9b`. Date: 2026-09-29.

## Conditions

- Production Next.js builds, Chromium, 1440 × 1000 desktop viewport.
- The pre-feature web build used the same gateway and database fixtures to isolate frontend changes.
- PostgreSQL benchmarks use connection-local temporary tables. The permanent Go benchmark runs ten samples for each of four history/message counts.
- HTTP stress fixture: eight executions, 500 native messages each, 14,324,541 bytes stored.
- Browser interaction samples include screenshots, resource timings, Event Timing, long tasks, layout shifts, heap size and DOM counts.
- `readyMs` includes browser automation overhead and is not INP. Input-to-paint figures below use Event Timing entries with a nonzero interaction ID.
- No application build ran during retained timing samples. A comparison checkout initially filled memory-backed `/tmp`; it was moved to disk. Interrupted captures and invalid fixture/readiness probes were excluded. OpenBao and the interrupted port-forwards were restored.

## Changes and measured results

| Operation | Before | After | Samples |
| --- | ---: | ---: | ---: |
| History SQL, 50 evaluations with large native transcripts | 369.4 ms | 79.7 ms | 10 each |
| Go history benchmark, 50 × 500 messages | 132.46 ms | 71.26 ms | 10 each |
| HTTP history, eight-execution fixture | 155.1 ms | 72.3 ms | 10 each |
| HTTP summary detail | 81.2 ms | 53.5 ms | 10 each |
| HTTP selected transcript | 570.2 ms | 125.5 ms | 10 each |
| Selected transcript response | 14,324,542 B | 1,798,399 B | Same fixture |
| Cancel response | 14,324,543 B | 8,951 B | 5 each |
| Cancel median HTTP latency | 297.1 ms | 183.5 ms | 5 each |
| Scatter metric tab, median input-to-paint | 224 ms | 56 ms | 9 each |
| 500-message transcript, browser ready time | 1,070.8 ms | 534.1 ms | 1 each, diagnostic only |

The SQL chained JSON deletion operators repeatedly copied large objects. Multi-key deletion and replacing only the execution array avoid those copies. The selected-transcript API no longer returns evidence for every model. Create, cancel and rejudge responses omit evidence after persistence.

Metric tabs previously unmounted and recreated the scatter chart. One chart now updates its selected metric. The nine-sample input-to-paint range changed from 208–256 ms to 40–192 ms. Total main-thread work improved much less; this is primarily a responsiveness improvement, not a claim that chart computation disappeared.

Go `benchstat` reports 14.31%, 46.80%, 25.26% and 46.20% lower time across the four cases, all with p ≤ 0.005. Go benchmarks use a smaller synthetic record shape than the native-transcript SQL experiment, so their absolute times should not be compared across fixtures.

During a 12-second active-judging capture, the page used 112.5 ms of main-thread task time and 6.1 ms of JavaScript time. The completed evaluation stops polling. A warm transcript reopen made no transcript request. Ten next/previous pagination interactions kept DOM counts bounded to 1,800–1,902 nodes for the large fixture.

## Repeated interaction coverage

The table lists median main-thread task time in milliseconds. It includes scripting, style/layout and other tasks during the capture window. Three repetitions per interaction unless noted. The final error/cache-key patches were also retested separately.

| Interaction | Pre-feature | Branch before | Revised branch |
| --- | ---: | ---: | ---: |
| chart-calls | — | 93.8 | 88.9 |
| chart-time | — | 107.7 | 79.5 |
| chart-tokens | — | 72.9 | 94.1 |
| dashboard-agent | 88.7 | 78.3 | 90.2 |
| dashboard-date | 72.0 | 84.9 | 81.7 |
| dashboard-page | 349.9 | 313.0 | 355.2 |
| dashboard-picker | 67.3 | 61.5 | 64.2 |
| dashboard-refresh | 45.3 | 47.4 | 45.7 |
| evidence-link | — | 56.7 | 63.7 |
| execution-close | — | 96.7 | 102.5 |
| execution-open | — | 88.5 | 83.3 |
| form-validation | — | 35.8 | 49.2 |
| graph-Fit View | 20.8 | 19.4 | 18.3 |
| graph-Toggle workflow summary | 18.0 | 21.2 | 20.1 |
| graph-Zoom In | 32.1 | 43.0 | 52.1 |
| graph-Zoom Out | 17.2 | 13.5 | 15.2 |
| graph-agent | 58.2 | 57.1 | 46.8 |
| graph-page | 120.9 | 110.9 | 121.3 |
| graph-workflow | 64.5 | 64.1 | 93.0 |
| judge-dropdown | — | 31.7 | 35.3 |
| judgment-tab | — | 57.1 | 61.4 |
| lens-File | 57.9 | 55.2 | 60.4 |
| lens-Network | 52.5 | 53.9 | 57.5 |
| lens-Process | 50.8 | 54.9 | 50.9 |
| lens-close | 89.8 | 84.4 | 78.7 |
| lens-model | 53.6 | 42.2 | 63.2 |
| lens-page | 278.4 | 286.9 | 247.9 |
| lens-sheet | 233.9 | 272.1 | 279.9 |
| lens-spans | 66.8 | 65.4 | 59.3 |
| lens-telemetry | 87.0 | 83.8 | 86.0 |
| lens-tool | 63.4 | 49.1 | 64.1 |
| model-call | — | 33.2 | 37.2 |
| model-dropdown | — | 34.5 | 44.0 |
| model-search | — | 10.1 | 11.7 |
| new-close | — | 101.7 | 94.8 |
| new-sheet | — | 120.8 | 102.9 |
| rejudge-close | — | 121.5 | 112.4 |
| rejudge-sheet | — | 97.9 | 91.5 |
| scores-tab | — | 158.6 | 115.8 |
| scoring-close | — | 75.7 | 84.6 |
| scoring-open | — | 84.0 | 80.4 |
| tool-call | — | 35.1 | 34.5 |
| transcript-tab | — | 90.3 | 70.5 |
| usage-tab | — | 149.8 | 140.2 |

The initial Lens sheet comparison showed roughly 40 ms more main-thread work on the branch. A follow-up with nine warm opens measured 72 → 80 ms median input-to-paint, 418 → 429 ms automation-inclusive ready time, and 103 → 135 ms total task time. JavaScript was 21.2 → 22.4 ms; layout was 5.1 → 5.5 ms. A three-cycle open/close rendering trace concentrated the remaining difference in style recalculation: 226.5 → 261.5 ms across all six transitions. Paint and layout did not increase in that trace. No network waterfall or repeated highlighter work was found on warm opens. This small remaining difference is recorded rather than described as a performance improvement.

The initial dashboard probes captured the first chart becoming available and sometimes contained another chart skeleton. A separate check waited for every skeleton to disappear. Three complete loads measured a median 568.7 ms before the feature and 601.5 ms on the final branch; median task time was 337.7 → 343.8 ms. These small samples do not establish a meaningful dashboard regression.

## Loading, correctness and recovery checks

- Results load as table rows and three chart plots, rather than solid placeholder cards.
- Model-loading sheets reserve space for selectors, workflow inputs and footer controls.
- Graph route fallbacks use the graph skeleton at both suspense boundaries.
- Transcript and syntax-highlighter loading use their own detailed placeholders.
- 800 ms simulated network latency: captured evaluation, form, code and transcript loading states.
- Blocked detail, provider and transcript requests: error display and Retry recovery.
- Fixed a failed detail request incorrectly displaying “No evaluations yet.”
- Saved inputs are read from the persisted request and displayed through a ghost “View inputs” button with a FileInput icon.
- Real form submission, persisted inputs after reload, running counters, cancellation and terminal state were exercised with the existing test agent.
- Rejudge submission, active polling and judge cancellation were exercised. Evaluation sessions remained absent from the chat sidebar.
- Model and judge selection, model search, empty-submit field validation, history selection, scoring dialog, execution sheet, judgment/transcript tabs and evidence navigation were exercised.
- Keyboard row opening, Escape closing, focus return, graph node details and browser back/forward passed. The workflow header retained its DOM identity across Graph/Evaluations switches.
- Desktop and 390 × 844 mobile input dialogs fit the viewport. Reduced-motion mode was included.
- Nested objects, arrays, Unicode, literal markup, null, empty objects and long inputs matched the saved JSON exactly. A long-input dialog kept its content in a 400 px scroll area.
- Similar-input switching passed after the cache-key fix. Error/Retry checks passed again after the empty-state fix.
- Similar saved inputs exposed a pre-existing syntax-highlighter cache collision: same length and identical first/last 100 characters returned stale text. Cache keys now include the complete language and source string.

## Reproduction and artifacts

Run the permanent integration check and benchmark against a migrated development database:

```sh
EVALUATION_TEST_DATABASE_URL=... go test ./internal/gateway/workflow/db -run TestEvaluationViews
EVALUATION_TEST_DATABASE_URL=... GOMAXPROCS=2 go test ./internal/gateway/workflow/db \
  -run "^$" -bench BenchmarkEvaluationHistory -benchtime=1s -count=10 -benchmem
```

Session artifacts are under `/tmp/agentz-perf-20260929`: `benchstat.txt`, `go-before.txt`, `go-after.txt`, SQL plans, HTTP samples, CPU profile, browser JSONL records and screenshots. The browser recording is `/root/.config/browser-harness/agent-workspace/recordings/workflow-performance-20260929`, with 680 captured frames. Temporary database/native-session fixtures and controller resources were removed; the original workspace type was restored.

Validation: production build, full web lint/type checking, relevant gateway/controller Go tests, Go vet, Go lint, and real database integration tests.

These measurements cover the changed workflow/evaluation journey and shared Graph, Lens and dashboard components on this host. They do not establish performance on every browser, device, provider or dataset. Four-times CPU throttling with eight models still produces noticeable chart work; the local test provider was used for lifecycle checks, not an assessment of judge accuracy.
