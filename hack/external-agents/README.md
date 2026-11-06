# External-agent integration validation

Use disposable clients, a disposable workspace, and an approved inference grant. Never commit OAuth profiles, provider credentials, browser storage state, or raw native startup logs.

## Installed Copilot CLI

Install `@github/copilot@1.0.106` (1.0.105 is the minimum validated version; the final pinned suite used 1.0.106), build `go build -o /tmp/agentz ./cmd/agentz-client`, then run:

```sh
python3 hack/external-agents/client_e2e.py --agentz /tmp/agentz --copilot /absolute/path/to/copilot --output /tmp/client-evidence
```

Add `--live-credentials /private/path` to test real provider inference. This file uses the supplied two-section format (OpenAI API Key / Anthropic API Key, each followed by its value). Keys stay in the harness and are never passed to the native CLI. This suite intentionally uses OAuth, catalog and MCP fixtures. Its report labels that boundary. `--provider claude-desktop --serve-only --keep` exports a connection and keeps a live Anthropic-backed fixture for native testing. `--resume-runtime /path/runtime.json` resumes the same disposable endpoint after interruption.

## Real control plane

Run the repository web/gateway and native Agentgateway data plane with PostgreSQL migrations, AgentZ/Gateway API/Agentgateway CRDs, ready workspace/provider resources, owner-local external authorization, and the private delegation gateway. The development test in this report used kind, PostgreSQL 18.6 and OpenBao 2.7.2. Namespace/provider provisioning was seeded; Cilium enforcement was not installed. This is not evidence for network-isolation certification.

Create a disposable client through Workspace → External agents, save its configuration, and run the normal `agentz login` command. The browser driver `approve_device.cjs` can approve either the real device flow or printed native PKCE URL using a pre-authenticated **test-account** browser state:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
AGENTZ_E2E_STORAGE_STATE=/private/test-browser-state.json \
AGENTZ_E2E_LOGIN_LOG=/private/client-login.log \
AGENTZ_E2E_ORIGIN=http://localhost:3100 \
AGENTZ_E2E_MODEL=gpt-5-mini node hack/external-agents/approve_device.cjs
```

`registration_e2e.cjs` creates all six client types and captures setup screenshots/video. Set `PLAYWRIGHT_MODULE`, `AGENTZ_E2E_STORAGE_STATE`, `AGENTZ_E2E_AGENTS_URL` (the workspace external-agents page), and `AGENTZ_E2E_OUTPUT`. It mutates that disposable workspace.

Once an inference grant is approved and current, test the real gateway contract:

```sh
python3 hack/external-agents/production_contract_e2e.py \
  --origin http://localhost:3100 \
  --token-file /private/test-profile/inference-oauth.json \
  --output /tmp/production-contract.json
```

The contract test requires a native Responses model. Run `agentz launch github-copilot-cli` first if the token needs refresh. The test includes a billable inference request.

The optional `TestLiveDelegationRuntime` integration test applies the actual namespace runtime reconciler to `AGENTZ_E2E_NAMESPACE` using `KUBECONFIG` and `AGENTZ_E2E_TRACE_HOST`. Use only a disposable namespace with existing grant routes, labeled `agentz.accuknox.com/e2e-external-agents=true`; it changes Kubernetes objects.

## Native clients

ChatGPT uses its own gateway OAuth store, shared with its isolated Codex profile. Linux requires an unlocked Secret Service default collection. For the headless test, a private D-Bus session and disposable in-memory default collection were used; do not substitute that temporary setup for a persistent desktop keyring deployment.

Claude Desktop imports structured schema-version-2 JSON. Confirm the imported configuration name before Apply Changes. A model route must retain a recognizable Claude model name; the live fixture uses `e2e/claude-sonnet-4-6`. Authenticate MCP before exporting to include its native header-helper connection. The helper receives an absolute profile directory, so a different desktop XDG environment cannot select a different relay key. It returns only the local relay capability, never provider keys or upstream OAuth tokens. Native testing exercised Allow once, Deny (no second tool request), then forced expiry of both resource token files before another successful native tool call; the fixture observed two independent refreshes. MCP GET returns 405 for this stateless Streamable HTTP fixture; query parameters are normalized before routing native Anthropic requests.

GitHub Copilot desktop requires a GitHub account sign-in before its provider UI. Its `desktop-connection.json` is a manual connection guide, not a native import format. Microsoft Copilot Code is a distinct product; no supported custom inference endpoint/standalone Code CLI has been established, so no misleading provider entry is registered.

See the HTML report under `docs/reports/external-agents-2026-11-06/` for tested versions, evidence and remaining release gaps.
