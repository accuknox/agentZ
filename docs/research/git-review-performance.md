# Git review performance and sandbox compatibility

Measured 2026-09-11 against `374473e` on `feat/coding-workspace`.

## Reproduction and changes

The original comparison started one `git diff --no-index` process per untracked
file. A temporary Git executable wrapper counted 1,005 Git processes per review
of 1,000 untracked files, including status and the tracked comparison. The wrapper
was removed from the measured runs.

Untracked files now use an isolated intent-to-add index and one batch diff.
The single-file path retains `--no-index` to avoid temporary-index overhead.
The same process-count probe measured seven Git processes per batched review.
Git owns binary, symlink, empty-file and literal-path handling. A regression check
compares the real index bytes before and after review.

The 100K replacement allocation profile identified per-line parsing and patch
formatting. Reads now preserve Git's patch text and parse only file headers with
the existing go-gitdiff library. One parser input buffer is reused per request.
Full hunk parsing and formatting run only when applying a selected hunk. The
follow-up allocation profile no longer lists `ParseTextChunk` or the formatter
among its top allocation sites; JSON escaping and output buffers remain.

## Controlled handler benchmarks

Linux amd64, AMD EPYC-Genoa, 8 logical CPUs, Go 1.26.5. Each benchmark calls the
actual filesystem Git HTTP handler, including Git processes, patch handling and
JSON serialization. Repository creation and one warmup request are outside the
measured `b.Loop`. Measurements use warm filesystem caches. Allocated bytes cover
the Go process and HTTP recorder, not Git child-process memory or peak RSS.

Two precompiled test binaries contain identical fixture/benchmark code. Ten
rounds alternate before/after order, AB then BA, with two operations per sample.
Builds, profiling and browser timing were kept outside these timed runs. Existing
background services remained running on the host.

```sh
go test -c -o /tmp/review.test ./internal/gateway/filesystem
/tmp/review.test -test.run='^$' -test.bench='^BenchmarkGitReview$' \
  -test.benchtime=2x -test.benchmem
# Repeat on baseline and changed code, alternating order for ten rounds.
benchstat before.txt after.txt
```

The benchmark lives in `internal/gateway/filesystem/git_test.go`. Apply that
benchmark to the baseline checkout before compiling its binary. Do not compare
runs while building or collecting CPU profiles. `benchstat` version used:
`golang.org/x/perf v0.0.0-20260908200009-22c9c6c9d4da`.

| Workload | Before median | After median | Time change | Go allocations before → after |
| --- | ---: | ---: | ---: | ---: |
| Status, 1,000 untracked | 26.21 ms | 26.31 ms | No significant change | 1,086.7 → 1,022.4 KiB |
| 1 untracked | 21.25 ms | 20.46 ms | No significant change | 74.41 → 72.84 KiB |
| 100 untracked | 354.63 ms | 36.54 ms | −89.70% | 1,487.2 → 446.4 KiB |
| 1,000 untracked | 3,475.8 ms | 113.4 ms | −96.74% | 13.652 → 3.811 MiB |
| 1,000 tracked modifications | 193.0 ms | 199.3 ms | No significant change | 5.344 → 3.933 MiB |
| 100K added lines | 144.4 ms | 101.2 ms | −29.92% | 71.28 → 33.35 MiB |
| 100K added + 100K removed | 250.9 ms | 167.3 ms | −33.32% | 142.84 → 67.17 MiB |
| Two sparse changes in 100K lines | 54.46 ms | 59.40 ms | No significant change | 73.19 → 70.32 KiB |

The four reported latency reductions have p < 0.001, n = 10. Status, single-file,
tracked-file and sparse-change latency differences are not statistically
significant. These are local measurements, not production service percentiles.

## Production browser measurements

Authenticated Coding E2E session, existing Kubernetes sandbox, production Next
standalone build, Chromium at 1440 × 1000. The fixture contains 1,000 untracked
one-line files. Each iteration reloads the page, opens Changes, then measures
Review changes click until populated diff content plus two animation frames.
This excludes page load/authentication and includes comparison fetching, worker
parsing and rendering. Reload clears the query cache; HTTP caches remain warm.

Ten baseline runs followed by ten changed-runtime runs used the same fixture and
frontend build. Unlike the Go runs, browser order was sequential, not interleaved.
The gateway also gained the compatibility guard between these browser runs.

- Before: median 4855.9 ms; samples 5177.0, 4735.6, 4743.2, 5005.3, 5130.4, 4756.1, 4887.3, 4883.0, 4828.8, 4762.9 ms.
- After: median 339.4 ms; samples 336.3, 311.7, 312.0, 352.3, 269.3, 369.9, 380.7, 325.3, 342.4, 366.6 ms.

All runs mounted 14 diff documents and 14 code rows. Long tasks were still
observed: 58–68 ms in two baseline runs and 51–61 ms in five changed runs.
The latency improvement does not mean all main-thread tasks stay below 50 ms.
Heap samples varied with GC timing and excluded worker heaps; no browser-memory
improvement or leak conclusion is drawn from them.

## Screenshot bug

The old sandbox filesystem returned `files`, `diff`, and `staged_diff`, without
`patches` or `revision`. The gateway decoded this into the current generated
result with an empty revision and absent patches. The browser showed a modified
file beside "No changes in this comparison". Staging sent `revision: ""` and
received HTTP 422: field `revision` did not match `^[a-f0-9]{64}$`.

This was reproduced against the old service on the existing sandbox, then in
the authenticated browser. The gateway now rejects responses missing the
required review revision with an explicit instruction to update the agent image
and restart the sandbox. Worktree removal remains exempt because successful
removal has no repository revision. No legacy response normalizer or generated
code edits were introduced.

The regression test failed before the fix with "status accepted an incompatible
sandbox: <nil>" and passes after it. Against the old service, the browser now
shows the update instruction. Against the updated service, all patches render
and checkbox stage/unstage round-trips were verified against the actual index.

Deploy the gateway and agent image from the same revision, and roll existing
sandboxes to that image. Restarting only the gateway or web process cannot update
a filesystem sidecar embedded in an older image. This run used the Coding E2E checkout, not the screenshot's checkout. An image
rollout for that separate environment is not claimed here.

The local Coding E2E Agent resource was rolled onto
`agentz-coding-e2e:git-review-20260911`, built from its existing image with the
updated AgentZ binary. Its normal filesystem sidecar on port 4097 now serves the
current protocol. After the rollout, a temporary Makefile edit rendered in the
production browser and its checkbox staged and unstaged the actual file. The
original Makefile, HEAD, clean index/worktree and stash list were restored.

## Final regression checks

- The complete 100K addition/removal patch contains both final lines. The browser
  reaches both with 108 split code rows mounted.
- Hunk stage, stale revision rejection and reverse staging preserve the other
  sparse change. The actual index was inspected after each operation.
- Stash preview includes untracked paths; apply restores staging; pop removes
  the saved entry only on success. A conflicting pop retains it. Drop and stale
  stash identity checks pass.
- Binary, empty, symlink, newline/Unicode names and header-looking contents are
  covered by the real-repository lifecycle regression check. It also verifies
  byte-for-byte preservation of the user's index during batched reads.
- Gateway and filesystem Go tests, both packages under the race detector, and
  `go vet` pass. No TypeScript or generated files changed in this follow-up.
- Owned benchmark files and commits were removed. The original HEAD, clean
  index/worktree and original empty stash list were verified before rollout.

The existing 64 MiB comparison limit still fails explicitly. These benchmarks
cover warm local reads; they do not measure disk-cold scans, arbitrary file
contents, peak worker memory or remote production network conditions.

## Raw latency samples

Each value is ns/op; each row contains ten samples, in measurement order.

### Before

```text
status_1000_untracked: 25209600, 24132870, 26466364, 26237200, 29422536, 29763794, 24168300, 22521632, 26185576, 27952898
untracked_1: 19825280, 18628550, 19098973, 19806840, 22337968, 21278173, 21222684, 22374433, 23646902, 22943700
untracked_100: 356082890, 347965157, 341345317, 297988785, 376220048, 389063825, 353175568, 347493480, 387450768, 381005132
untracked_1000: 3515228679, 3480480359, 3376644834, 3418668472, 3471069050, 3578745375, 3571700258, 3636156770, 3371728316, 3458176638
tracked_1000: 143529290, 192858995, 219835637, 191741210, 164232356, 192640966, 208548644, 210807453, 193188324, 211805240
added_100k: 144261037, 144529890, 129693249, 143283941, 157305612, 136654996, 145765075, 147037654, 139404174, 156503706
replaced_100k: 245505790, 255110116, 251255349, 274928786, 285568632, 250561106, 249422938, 274487743, 250398668, 248064588
sparse_100k: 55198048, 67940140, 53612775, 50564610, 48047300, 65422052, 57352644, 57451808, 53388426, 53724950
```

### After

```text
status_1000_untracked: 22884006, 26349004, 25124956, 27975518, 22674717, 27445254, 26262706, 26797923, 27619369, 23358194
untracked_1: 19314666, 20677681, 18252082, 22664492, 19292918, 20241858, 21381138, 21482106, 23123590, 18124247
untracked_100: 36666822, 29910444, 39327346, 36773327, 37491910, 38950972, 35589002, 36415189, 28963022, 30749854
untracked_1000: 119440450, 100218018, 116590772, 121978139, 96954202, 117546589, 107762093, 113867496, 112918450, 106667168
tracked_1000: 214087668, 200310696, 198203230, 195467482, 203451177, 207369634, 155156368, 203891085, 187541740, 160384148
added_100k: 101321738, 108602499, 100525112, 88946419, 96297010, 97689730, 104753488, 101060404, 122173873, 113170534
replaced_100k: 186910592, 178440510, 154173842, 167605700, 201859109, 181537387, 149290604, 164172586, 165928148, 167003154
sparse_100k: 54726310, 57904701, 61606184, 60900752, 64167172, 53640115, 49831408, 63757199, 68356718, 53693294
```

## Full benchstat comparison

```text
goos: linux
goarch: amd64
pkg: github.com/accuknox/agentz/internal/gateway/filesystem
cpu: AMD EPYC-Genoa Processor
                                  │ /tmp/agentz-review-final-before.txt │  /tmp/agentz-review-final-after.txt  │
                                  │               sec/op                │    sec/op     vs base                │
GitReview/status_1000_untracked-8                          26.21m ± 12%   26.31m ± 13%        ~ (p=0.853 n=10)
GitReview/untracked_1-8                                    21.25m ± 10%   20.46m ± 11%        ~ (p=0.529 n=10)
GitReview/untracked_100-8                                 354.63m ±  9%   36.54m ± 18%  -89.70% (p=0.000 n=10)
GitReview/untracked_1000-8                                3475.8m ±  3%   113.4m ± 12%  -96.74% (p=0.000 n=10)
GitReview/tracked_1000-8                                   193.0m ± 15%   199.3m ± 20%        ~ (p=0.971 n=10)
GitReview/added_100k-8                                     144.4m ±  8%   101.2m ± 12%  -29.92% (p=0.000 n=10)
GitReview/replaced_100k-8                                  250.9m ± 10%   167.3m ± 12%  -33.32% (p=0.000 n=10)
GitReview/sparse_100k-8                                    54.46m ± 20%   59.40m ± 10%        ~ (p=0.315 n=10)
geomean                                                    150.4m         67.81m        -54.91%

                                  │ /tmp/agentz-review-final-before.txt │    /tmp/agentz-review-final-after.txt    │
                                  │                 B/s                 │      B/s        vs base                  │
GitReview/status_1000_untracked-8                         2.518Mi ± 11%    2.513Mi ± 15%          ~ (p=0.796 n=10)
GitReview/untracked_1-8                                   29.30Ki ± 33%    29.30Ki ± 33%          ~ (p=0.628 n=10)
GitReview/untracked_100-8                                 127.0Ki ±  8%   1230.5Ki ± 22%   +869.23% (p=0.000 n=10)
GitReview/untracked_1000-8                                127.0Ki ±  8%   3945.3Ki ± 13%  +3007.69% (p=0.000 n=10)
GitReview/tracked_1000-8                                  2.365Mi ± 18%    2.275Mi ± 24%          ~ (p=1.000 n=10)
GitReview/added_100k-8                                    19.16Mi ±  8%    27.34Mi ± 11%    +42.68% (p=0.000 n=10)
GitReview/replaced_100k-8                                 22.05Mi ±  9%    33.06Mi ± 10%    +49.96% (p=0.000 n=10)
GitReview/sparse_100k-8                                   19.53Ki ±  0%    19.53Ki ±  0%          ~ (p=1.000 n=10)
geomean                                                   632.2Ki          1.379Mi         +123.32%

                                  │ /tmp/agentz-review-final-before.txt │   /tmp/agentz-review-final-after.txt   │
                                  │                B/op                 │      B/op       vs base                │
GitReview/status_1000_untracked-8                        1086.7Ki ± 10%   1022.4Ki ±  7%        ~ (p=0.247 n=10)
GitReview/untracked_1-8                                   74.41Ki ±  2%    72.84Ki ±  1%   -2.12% (p=0.019 n=10)
GitReview/untracked_100-8                                1487.2Ki ±  4%    446.4Ki ± 15%  -69.99% (p=0.000 n=10)
GitReview/untracked_1000-8                               13.652Mi ±  0%    3.811Mi ±  0%  -72.08% (p=0.000 n=10)
GitReview/tracked_1000-8                                  5.344Mi ±  0%    3.933Mi ± 13%  -26.41% (p=0.000 n=10)
GitReview/added_100k-8                                    71.28Mi ±  0%    33.35Mi ±  0%  -53.21% (p=0.000 n=10)
GitReview/replaced_100k-8                                142.84Mi ±  0%    67.17Mi ±  0%  -52.98% (p=0.000 n=10)
GitReview/sparse_100k-8                                   73.19Ki ±  4%    70.32Ki ±  4%   -3.92% (p=0.002 n=10)
geomean                                                   2.963Mi          1.705Mi        -42.47%

                                  │ /tmp/agentz-review-final-before.txt │ /tmp/agentz-review-final-after.txt  │
                                  │              allocs/op              │  allocs/op   vs base                │
GitReview/status_1000_untracked-8                           6.593k ± 0%   6.593k ± 0%        ~ (p=0.643 n=10)
GitReview/untracked_1-8                                      695.5 ± 1%    661.0 ± 1%   -4.96% (p=0.000 n=10)
GitReview/untracked_100-8                                  14.529k ± 0%   3.094k ± 0%  -78.70% (p=0.000 n=10)
GitReview/untracked_1000-8                                 139.73k ± 0%   23.84k ± 0%  -82.94% (p=0.000 n=10)
GitReview/tracked_1000-8                                    61.64k ± 0%   25.62k ± 0%  -58.43% (p=0.000 n=10)
GitReview/added_100k-8                                    300836.0 ± 0%    741.0 ± 0%  -99.75% (p=0.000 n=10)
GitReview/replaced_100k-8                                 600766.5 ± 0%    662.5 ± 1%  -99.89% (p=0.000 n=10)
GitReview/sparse_100k-8                                      681.5 ± 1%    584.0 ± 1%  -14.31% (p=0.000 n=10)
geomean                                                     22.71k        2.640k       -88.37%
```
