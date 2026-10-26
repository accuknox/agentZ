# AgentGateway runtime

The Nix package pins AgentGateway and applies `telemetry.patch` and `guardrails.patch`. Build it with `nix build .#agentgateway`; build its container with `nix build .#agentgatewayImage`. Neither build depends on `.ref` checkouts.

AgentZ compiles native prompt guards, including regex presets, scopes, audit actions, failure modes, and remote provider connections. The guardrail patch adds contextual errors and telemetry at the existing evaluation boundary. It does not add another detector or change streaming into buffered delivery.

Each check's native custom-response body contains the generated `GuardrailRejection` JSON contract. The runtime reads that typed configuration, adds measured content context, and renders the rejection for the client-facing Chat Completions, Responses, or Messages format. Legacy custom-response bodies retain upstream behavior. Provider rejection bodies do not replace AgentZ's configured safe explanation.

Policy violations use HTTP 422. Checker failures have a separate code and reason. Mid-stream failures use the API's error event and discard held content. Regex evaluations identify the matching content class. Cloud detectors that return a combined verdict report the inspected classes without guessing which part matched. Context and configured labels are also exported through native `guardrails` telemetry, so later configuration edits do not change historical labels.

Checked streaming inspects overlapping windows. Already delivered content cannot be retracted, and whole-response detection is not guaranteed. Managed clients reject output masking, enforcing mutating providers, and custom expressions needing unbounded or anchored context. Tool arguments and results refer to content within model API traffic, not MCP execution.

Optional enforcing mutations cannot follow mandatory organization checks in the same phase. Webhook masking replaces text within the original structured messages, preserving tool calls, results, and non-text content. Masked responses must preserve inspected message counts and roles. Independently configured external clients own their retry behavior; AgentZ's Codex launcher retains the POC's retry protections.

Run the actual proxy fixtures with:

```sh
AGENTGATEWAY_BINARY=result/bin/agentgateway python3 hack/agentgateway/tests/native-fixtures.py
```

The fixtures cover the native request/response behavior, scopes, audit and masking actions, checked streams, webhook failures, and model pools. Client probes exercise real binaries with `--opencode --codex --claude`. Set `OPENCODE_BINARY` and `CLAUDE_BINARY` to the desired executables. Optional `MODEL_ARMOR_TEST_TEMPLATE` and `BEDROCK_TEST_GUARDRAIL` enable live cloud cases.

The agent image also applies `hack/opencode/guardrails.patch`. This keeps policy violations non-retryable and displays standard Responses streaming errors through OpenCode’s existing error handling. Guardrail event metadata expires after 30 days and never includes inspected content.
