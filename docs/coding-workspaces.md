# Coding workspaces

Coding workspaces add personal GitHub projects to the existing workspace and agent access model. A workspace's type is chosen at creation. Existing workspaces remain General purpose.

Projects and agents are independent workspace resources. A thread links one project to one agent, which stays fixed for that thread. Project records belong to their creator. Sharing an agent exposes its threads and filesystem; it does not grant access to the creator's project management pages. Superadmins have no exception to project ownership or GitHub account selection.

## Checkout layout

Each project has an independent checkout on each agent:

```
/home/agentz/Projects/<base64url-user-id>/github/<project-id>/repo/
/home/agentz/Projects/<base64url-user-id>/github/<project-id>/worktrees/<worktree-id>/
```

A new thread defaults to a new branch and worktree. Users can choose the main checkout or reuse an existing worktree. Once multiple threads have used a worktree, thread filesystem revert remains disabled for that worktree. Deleting or archiving a thread does not remove its files. Checkout cleanup is explicit and requires an available, idle agent with no running terminals, dirty files, or unpushed commits. Remove linked worktrees before the main checkout. Project deletion requires all checkouts to have been removed.

## GitHub credentials

The Coding connection is separate from GitHub sign-in. It accepts a GitHub App on github.com with expiring user access tokens. It does not accept personal access tokens or installation credentials. Each UI operation uses the acting user's connection. Neither resource ownership nor an administrator role selects another user's connection.

OAuth uses PKCE and one-use state bound to the exact user and login session. The callback verifies the numeric GitHub user ID. Access and refresh tokens are encrypted with AES-256-GCM, with the application user ID and GitHub user ID authenticated alongside the ciphertext. Refresh rotation is serialized through a database row lock and committed before subsequent network operations.

Native Git runs in two places:

- The agent filesystem service performs local Git operations without credentials.
- The web process runs trusted Git operations in a fresh, owned bare repository. Only repository bundles cross into it. Agent config, hooks, executables, environment, and worktree files are not imported.

Authenticated Git transport passes the user token only to a trusted subprocess environment. It never appears in agent requests, process arguments, Git configuration, bundles, PTYs, MCP tools, or a credential proxy. GitHub errors are sanitized before returning to the browser. UI commits bind to a reviewed tree and parent commit and use the verified acting user's GitHub noreply identity. Existing commits retain their authors. Pushes require an exact remote lease and fast-forward ancestry.

Infrastructure operators remain trusted. The guarantee applies to application users, application administrators, and agents; a host operator who can read process memory or replace server code controls the deployment.

## Deployment

Configure these secrets only on the web deployment:

- `CODING_GITHUB_CLIENT_ID`: GitHub App client ID.
- `CODING_GITHUB_CLIENT_SECRET`: GitHub App client secret.
- `CODING_GITHUB_ENCRYPTION_KEY`: 32 random bytes encoded as 64 lowercase hexadecimal characters. Keep this key stable across deployments.

Register `<BETTER_AUTH_URL>/api/github/callback` as the App callback. Enable expiring user access tokens. Grant repository Contents read/write, Pull requests read/write, Issues read, and Metadata read. Workflow file changes also require Workflows write. Install the App on the repositories users should be able to select. User tokens remain constrained by both App permissions and the user's own repository permissions.

The Helm web chart exposes the corresponding `env.codingGithubClientID`, `secrets.codingGithubClientSecret`, and `secrets.codingGithubEncryptionKey` values. An existing Kubernetes Secret can supply the same environment keys. Never put them in agent secrets or sandbox environment variables.

The web image includes native Git and CA certificates. The agent image includes Git and the filesystem command. Repository bundles are limited to 64 MiB. Git LFS and submodule provisioning are outside this version. Browser and app previews are also outside this version.

## Research

The repositories below were cloned under `.ref/` and inspected before implementation:

| Reference | Revision | Findings used here |
| --- | --- | --- |
| [T3 Code](https://github.com/pingdotgg/t3code) | `0f602b3372b300ae94084bd3fe7dbaadaa58ba3a` | Project navigation, project threads, Git worktrees, review and terminal workflow. Its ambient GitHub credentials and inherited process environment do not fit AgentZ's credential boundary. |
| [OpenCode](https://github.com/anomalyco/opencode) | `a3647eb025c7615159d417dcc49fc39fdaeba65b`, v1.18.16 | Existing AgentZ SDK pin, directory routing, session metadata, shared filesystem snapshots, and PTY protocol. OpenCode projects are not application project IDs. |
| [Pierre](https://github.com/pierrecomputer/pierre) | `e78fbd118e4a36c72fbf456232b9b6eaf0aa0ba3` | Reuse the diff renderer alongside the existing file tree. |
| [go-git](https://github.com/go-git/go-git) | `fecc378865070c30b3e75f6f998948aca6edd32d` | Evaluated Git support. Native Git provides the required worktree and transport behavior. |
| [Octokit OAuth user auth](https://github.com/octokit/auth-oauth-user.js) | `6030b1fa583eda14b0a068a4ce16b8d3f6291e5c` | Evaluated refresh handling. In-memory rotation alone is insufficient across web replicas; persist rotation under a database lock. |
| [xterm.js](https://github.com/xtermjs/xterm.js) | `c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2` | Terminal rendering and fit addon. |

GitHub's [user access token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) explains the intersection of App and user permissions, PKCE parameters, numeric user verification, and token lifetime. Its [refresh documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens) defines refresh rotation.

## Validation

The following checks passed on 10 September 2026. Browser checks used the production Next.js build, PostgreSQL, the Go gateway, and a Kubernetes agent running the built image. The agent and filesystem containers ran as UID 1000.

| Area | Verified behavior |
| --- | --- |
| Build | `go test ./...`, web TypeScript and ESLint checks, production Next.js build, native agent image build, and Helm lint and rendering. SQL and API outputs were regenerated from their sources. |
| Workspace creation | Coding selection and confirmation; General purpose remains the default and opens the existing agent workflow. |
| Project ownership | Browser project rename works. A second authenticated superadmin cannot list, read, rename, delete, join, or remove another user's project checkout. |
| Agent sharing | A regular member with only `use_shared` can create personal projects and separate checkouts. Shared threads are accessible; the creator's project remains private. Revoking the share denies an already-issued bearer token. |
| Threads | Project composer creation, provisioning retry, persisted session binding, generic manual creation rejection for both users and scoped API keys, and permanent revert protection after worktree reuse. Deleting a thread removes its project listing and conversation metadata while retaining the checkout. |
| Local Git | Real Git tests cover staging, unstaging, newline filenames, stale-head rejection, unsafe paths, dirty and unpushed cleanup protection, and cleanup after switching branches. Live branch switching updates the stored checkout label. |
| Review and terminal | Browser diff rendering, staging and unstaging, terminal connection, input and output on Kubernetes, and retained terminal focus after an agent reply. The mobile Code panel fits a 390-pixel viewport and returns to chat. |
| Files | Browser read, save, create, rename, and delete within the selected worktree, with immediate explorer refresh. An agent-side concurrent edit raises a conflict; reloading preserves the agent's version. |
| Cleanup | Running terminals block removal. Linked worktrees must be removed before the main checkout. Cleanup removes associated sessions and then permits project deletion. |
| GitHub identity | Tests against PostgreSQL and controlled GitHub responses cover PKCE, exact user/session binding, replay rejection, encrypted token ownership, numeric identity verification, refresh durability and concurrency, revocation retry, and signed-out denial. |
| Live GitHub | Browser OAuth, installed repository selection, project creation, authenticated clone into a new worktree, staging, commit, push, PR creation and reuse, PR and empty issue lists, stale-push rejection, and fast-forward pull passed against `murtaza-u/dot`. GitHub attributes the UI-created commit's author and committer to the connected user. |
| Live credential boundary | A UI request rotated and persisted both GitHub tokens after the test marked the connection expired. A second authenticated AgentZ superadmin could not use the owner's connection. Neither identity nor GitHub responses were mocked for these checks. The deployed agent and filesystem containers have no Coding GitHub credentials configured. |
| Trusted Git | Real repository bundles verify config and hook isolation, reviewed tree and parent checks, acting-user commit identity, preservation of existing authors, and absence of credentials from exported bundles. |

The chat transport test used a controlled OpenAI-compatible inference endpoint through the deployed inference service. It verifies message transport and rendering, not a live model's coding ability.

Run the repeatable Git tests with `cd web && bun run test:coding`. The GitHub identity test is skipped unless `CODING_TEST_DATABASE_URL` points to a PostgreSQL test database with the Drizzle migrations applied. It creates temporary users, uses generated test keys and controlled GitHub responses, and removes its fixtures. The command uses the Node runtime supplied by the repository's Nix development environment.

The live test used the AgentZ Coding Workspace Dev GitHub App and the connected account `murtaza-u`. All repository writes stayed on `agentz/ee73f841-87c6-4d37-81a4-43e770ca2a51`. The UI created commit `8e3cee67551cee83ecb7d39d1196091970dc72f7`. A remote fixture commit then exercised stale-push rejection and pull. [Test PR #1](https://github.com/murtaza-u/dot/pull/1) was closed without merging. The test branch remains available for inspection. The `main` branch remained at `053cce05d18617aa7637eb6c65d2f1315e436c39` throughout.

Live coverage used one GitHub account and a public repository with no open issues. Private repository access, populated issue lists, a second GitHub identity, and live disconnect/reconnect were not exercised. Controlled provider tests cover identity mismatch and revocation behavior. These checks do not establish full T3 Code feature parity or exhaustive coverage of every failure mode.
