# Coding workspace UI audit

Date: 2026-09-12. Baseline: `eae4b57` on `feat/coding-workspace`.

The audit used the production Next.js build, authenticated Chromium, the
existing Coding E2E agent in Kubernetes, and live GitHub repository reads.
Desktop and narrow layouts were checked at 1440, 390, and 320 pixels, including
short viewports and light/dark themes. The collapsed tool rail remains the
starting layout.

## Reproduced defects and fixes

| Defect | Evidence and fix |
| --- | --- |
| Project actions stranded in the header | Two independent auto margins put the project menu at x=969 while Files was at x=1400. Grouped the actions at the right edge and tightened breadcrumb spacing. |
| Project settings overflow | A 576-pixel dialog had 1,346 pixels of content. Constrained checkout rows, separated branch/agent/status/path, retained full values in titles, and used the shared dialog footer. No horizontal overflow at the tested widths. |
| Add-project navigation stalls | Creation succeeded twice while the old route remained active. Removed the refresh competing with navigation. The retest opened the new project directly. |
| Stale Changes list on opening | Editing in Files then opening Changes showed the cached zero-file count until the five-second poll. Refresh status when opening Changes or GitHub. |
| Blank stash search results | A search matching no saved entry left an empty list. Show an explicit no-results state. |
| Stash dialog sizing | The unprefixed width override displaced the shared narrow-screen sizing. Use the desktop breakpoint and constrain the virtual list. |
| Failed review claims no changes | A rejected diff request showed both an error and “No changes in this comparison.” Suppress the false empty state and offer Retry. Also provide Retry for an initial status failure. Both recovery paths passed. |
| Deleted checkout threads remain in sidebar | Thread records were deleted, but cards remained until a full reload. The deletion query omitted the existing chat-list notification. Added the notification in SQL, regenerated with sqlc, and verified immediate removal through the live sidebar. |

## Browser coverage

| Area | Interactions exercised |
| --- | --- |
| Workspace setup | General/Coding selector, required-name validation, confirmation, coding workspace creation, provisioning, no-agent/no-project state, and deletion of the disposable workspace. General-workspace navigation and its no-agent chat state also checked. |
| Projects | Project cards and switcher; GitHub repository search, no results, pagination from 50 to 100 entries; create; rename with a long name; empty/populated settings; checkout removal and cancellation; project deletion and cancellation. |
| Thread creation | New worktree, first main checkout, existing checkout, session-route promotion, composer submission, interrupted request, delayed streamed response, private-thread revert, and disabled revert after checkout reuse. |
| Header and rail | Project and generic-session headers; open/close Files; collapsed rail; every tool panel; expand/restore; keyboard resize from 480 to 496 and back; Ctrl+Shift+B and Ctrl+backtick. |
| Files | Scoped explorer; search/no results/clear; new file/folder; editing and saving verified on disk; Markdown preview/source; copy; download verified against saved contents; rename into a folder; dirty-close cancellation/discard; external-write conflict and reload; recursive folder deletion; large-file read-only behavior. |
| Terminal | Empty state; two sessions with independent commands; correct working directory; tab switching; panel switching; reconnect with replay; clear; closing active and last tabs; narrow-screen tab layout. |
| Git review | Clean and dirty state; file and hunk stage/unstage; All/Unstaged/Staged; binary file; 100,000 added lines; final-line scrolling; split/unified and wrapping; file collapse/expand; previous/next hunk; copy commit hash and worktree path; initial status failure/retry; diff failure/retry. |
| Stashes | Create including untracked files; review; search/no match/clear; apply and keep; pop; drop and cancellation; empty list; narrow dialogs. Git refs and restored files were checked in the sandbox. |
| Session context | Empty session; real message/token updates through the test inference service; long model identifier, large token counts, all task statuses and priorities through a typed response fixture; narrow and dark layouts. |
| GitHub | Live repository status and refresh, empty PR/issue lists, published/unpublished branch controls, PR form entry and cancellation, and its 320-pixel layout. No PR was submitted. |
| Account connection | Connected account and success, connection-failure, and revocation-failure banners. OAuth ownership, replay, refresh and revocation behavior covered by the existing controlled integration test. |

The commit composer was thoroughly exercised immediately before this audit in
`eae4b57`: real commits with and without a body, failure retention, AI-message
splitting, the 50-character subject highlight and horizontal scroll, 80-column
body wrapping, paragraphs, caret/selection behavior, and the combined size
limit. This audit retained that implementation and exercised its staging inputs
and narrow layout.

Live GitHub pushes, PR submission, account revocation, and a new OAuth consent
flow were not performed during this audit. The PR form used live repository
data; OAuth tests used controlled responses. This record describes the tested
coverage, not a claim about every browser or every possible repository state.

## Large-diff measurement

Three fresh-page runs loaded a 100,000-line added file together with a tracked
edit, a binary file, and a small text file:

| Run | Review click to painted code |
| --- | ---: |
| 1 | 454.5 ms |
| 2 | 427.0 ms |
| 3 | 459.5 ms |

Median: 454.5 ms. Initially 46 diff rows were mounted across four documents;
scrolling to line 100,000 left 54 rows mounted. A browser PerformanceObserver
recorded no main-thread long tasks during these three review loads. These are
regression measurements, not a before/after speedup claim. Earlier optimization
benchmarks and their methodology are in [git-review-performance.md](git-review-performance.md).

## Validation and cleanup

- Production Next.js build, including TypeScript checking: passed.
- ESLint for all four changed React files: passed.
- `go test ./internal/gateway/...`: passed.
- Existing coding integration tests: 2 passed, 0 skipped. They cover trusted
  commit identity/tree and GitHub PKCE, actor/session binding, replay,
  encryption ownership, refresh rotation, and revocation retry.
- sqlc generation changed only the intended generated query. No generated file
  was edited manually.
- Disposable projects, their checkouts and threads, the temporary workspace,
  test terminals, and file fixtures were removed. Original sandbox HEAD,
  index, working tree, and stash list were restored and checked.

Two test-environment issues were repaired during the run: the delayed inference
fixture was stopped, and the local manager's gateway token had expired. The
expired token caused a 401 status callback despite a Ready Kubernetes resource;
renewing it allowed provisioning to finish. Neither required application
compatibility code.
