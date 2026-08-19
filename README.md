<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/brand/agentz-lockup-ondark.svg">
  <img src=".github/assets/brand/agentz-lockup.svg" alt="AgentZ" width="300">
</picture>

<h3>Zero Trust Agentic AI Platform</h3>

<p><b>Build, run, and govern production AI agents. Secure by design.</b></p>

<p>
Every agent runs inside a default-deny sandbox and never receives a credential.<br>
Every model call and tool call lands in a replayable trace.
</p>

<p>
<a href="https://agentzharness.ai/"><img src="https://img.shields.io/badge/Start%20free-agentzharness.ai-0B5FFF?style=for-the-badge&logo=rocket&logoColor=white" alt="Start free"></a>
<a href="https://www.youtube.com/watch?v=mAzLWcr59g0"><img src="https://img.shields.io/badge/Watch%20the%20demo-YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch the demo"></a>
<a href="https://docs.agentzharness.ai/"><img src="https://img.shields.io/badge/Docs-docs.agentzharness.ai-1F2937?style=for-the-badge&logo=readthedocs&logoColor=white" alt="Docs"></a>
<a href="https://accuknox.com/platform/agentz/"><img src="https://img.shields.io/badge/Product-AccuKnox-111827?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Product page"></a>
</p>

<p>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="Apache 2.0"></a>
<a href="go.mod"><img src="https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white" alt="Go 1.26"></a>
<img src="https://img.shields.io/badge/Kubernetes-operator-326CE5?logo=kubernetes&logoColor=white" alt="Kubernetes operator">
<img src="https://img.shields.io/badge/network-Cilium%20default--deny-F8C517?logo=cilium&logoColor=black" alt="Cilium default-deny">
<img src="https://img.shields.io/badge/secrets-OpenBao-FFEC6E?logo=vault&logoColor=black" alt="OpenBao">
<img src="https://img.shields.io/badge/telemetry-OpenTelemetry-425CC7?logo=opentelemetry&logoColor=white" alt="OpenTelemetry">
<img src="https://img.shields.io/badge/tools-MCP-000000?logo=modelcontextprotocol&logoColor=white" alt="MCP">
</p>

<p>
<a href="https://github.com/accuknox/agentZ/stargazers"><img src="https://img.shields.io/github/stars/accuknox/agentZ?style=flat&logo=github&color=FFD700" alt="Stars"></a>
<a href="https://github.com/accuknox/agentZ/issues"><img src="https://img.shields.io/github/issues/accuknox/agentZ?logo=github" alt="Issues"></a>
<a href="https://github.com/accuknox/agentZ/pulls"><img src="https://img.shields.io/github/issues-pr/accuknox/agentZ?logo=github" alt="Pull requests"></a>
<a href="https://github.com/accuknox/agentZ/commits"><img src="https://img.shields.io/github/last-commit/accuknox/agentZ?logo=git&logoColor=white" alt="Last commit"></a>
<img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome">
</p>

<a href="https://www.producthunt.com/products/agentz?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-agentz" target="_blank" rel="noopener noreferrer"><img alt="AgentZ - Zero Trust Platform to Build, Run Govern AI Agents | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1216150&theme=light&t=1787120477230"></a>

<br><br>

<a href="https://www.youtube.com/watch?v=mAzLWcr59g0">
  <img src="https://img.youtube.com/vi/mAzLWcr59g0/maxresdefault.jpg" alt="Watch the AgentZ demo on YouTube" width="720">
</a>

<p><i>AgentZ | Build, Run and Automate AI Agents.
<a href="https://www.youtube.com/watch?v=mAzLWcr59g0">Watch on YouTube</a></i></p>

</div>

---

## Contents

- [What AgentZ is](#what-agentz-is)
- [The three ideas](#the-three-ideas)
- [Watch it work](#watch-it-work)
- [Take the tour](#take-the-tour)
- [How it works](#how-it-works)
- [Platform components](#platform-components)
- [Custom resources](#custom-resources)
- [Quick start](#quick-start)
- [Local development](#local-development)
- [Repository layout](#repository-layout)
- [How AgentZ compares](#how-agentz-compares)
- [Deployment options](#deployment-options)
- [Documentation](#documentation)
- [FAQ](#faq)
- [Contributing](#contributing)
- [Contributors](#contributors)
- [Security](#security)
- [License](#license)

---

## What AgentZ is

AgentZ is a Kubernetes-native control plane for AI agents. It gives each agent
strong isolation, zero-trust secret management and a default-deny network posture.
You also control which software packages the agent can reach.

Most agent platforms treat isolation as a setting you switch on later. AgentZ
starts every agent inside a sandbox. The agent reaches only the destinations you
allowed, receives no credential it could leak, and records every call it made.

The platform is model agnostic and framework agnostic. Run OpenAI, Anthropic,
Google, or a self-hosted open-weight endpoint on your own key. Wrap an existing
LangGraph or CrewAI agent, or build skills natively.

## The three ideas

**Default-deny networking.** An agent pod sends traffic only to destinations its
Sandbox lists. Cilium network policies block everything else at the kernel, and
every block lands in the trace.

**Zero-trust secrets.** The agent container never receives a secret value. A
sidecar proxy intercepts each outbound request, resolves the reference against
OpenBao, and substitutes the real value before the request leaves.

**Control over what agents can run.** Define the tools and the packages once in a
Sandbox. Reuse that definition across many agents. Update it in one place and
every agent picks up the change.

## Watch it work

Every clip is a real recording from the product. Click a thumbnail to play the
full video.

<table>
<tr>
<td width="50%" valign="top">
<a href="https://accuknox.com/platform/agentz/assets/video/hero-workflow-graph.mp4"><img src="https://accuknox.com/platform/agentz/assets/video/hero-workflow-graph.jpg" alt="A workflow running live in AgentZ" width="100%"></a>
<b>Live workflow graph</b><br>
Steps move through running and succeeded while the run happens.
</td>
<td width="50%" valign="top">
<a href="https://accuknox.com/platform/agentz/assets/video/0-agentz-chat.mp4"><img src="https://accuknox.com/platform/agentz/assets/video/0-agentz-chat.jpg" alt="Chat interface in AgentZ" width="100%"></a>
<b>Chat with your agents</b><br>
Ask, build, and run workflows in plain language. Files and run history stay with the agent.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://accuknox.com/platform/agentz/assets/video/build-create-agent.mp4"><img src="https://accuknox.com/platform/agentz/assets/video/build-create-agent.jpg" alt="Creating an agent in AgentZ" width="100%"></a>
<b>Create an agent</b><br>
Pick a sandbox, skills, persistent memory and a model provider in one form.
</td>
<td width="50%" valign="top">
<a href="https://accuknox.com/platform/agentz/assets/video/run-chat-workflows.mp4"><img src="https://accuknox.com/platform/agentz/assets/video/run-chat-workflows.jpg" alt="Running workflows from chat in AgentZ" width="100%"></a>
<b>Run workflows from chat</b><br>
The file explorer and the run history sit next to the conversation.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://accuknox.com/platform/agentz/assets/video/dynamic-skill-generation.mp4"><img src="https://accuknox.com/platform/agentz/assets/video/dynamic-skill-generation.jpg" alt="Dynamic skill generation in AgentZ" width="100%"></a>
<b>Generate skills on demand</b><br>
Describe the task. AgentZ writes the skill, wires the steps, and shares it with the team.
</td>
<td width="50%" valign="top">
<a href="https://accuknox.com/platform/agentz/assets/video/govern-sandbox-permissions.mp4"><img src="https://accuknox.com/platform/agentz/assets/video/govern-sandbox-permissions.jpg" alt="Scoping a sandbox in AgentZ" width="100%"></a>
<b>Scope a sandbox</b><br>
Set per-tool permissions and allowed hosts. Every call is allowed or blocked at the kernel.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://accuknox.com/platform/agentz/assets/video/zero-credential-exposure.mp4"><img src="https://accuknox.com/platform/agentz/assets/video/zero-credential-exposure.jpg" alt="Zero credential exposure in AgentZ" width="100%"></a>
<b>Zero credential exposure</b><br>
Credentials are scoped, injected at runtime, and never stored in the agent context.
</td>
<td width="50%" valign="top">
<a href="https://accuknox.com/platform/agentz/assets/video/card-mcp-connect.mp4"><img src="https://accuknox.com/platform/agentz/assets/video/card-mcp-connect.jpg" alt="Connecting an MCP server in AgentZ" width="100%"></a>
<b>Connect an MCP server</b><br>
Pick a provider, authorize once, and watch it go Ready.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://accuknox.com/platform/agentz/assets/video/card-mcp-profiling.mp4"><img src="https://accuknox.com/platform/agentz/assets/video/card-mcp-profiling.jpg" alt="Profiling MCP tool calls in AgentZ" width="100%"></a>
<b>Profile MCP tool calls</b><br>
One graph shows every tool an agent called, with latency and last-used age.
</td>
<td width="50%" valign="top">
<a href="https://accuknox.com/platform/agentz/assets/video/card-schedule-cron.mp4"><img src="https://accuknox.com/platform/agentz/assets/video/card-schedule-cron.jpg" alt="Editing a cron schedule in AgentZ" width="100%"></a>
<b>Schedule an agent</b><br>
Set a cron, then edit the schedule, the timeout and the retention in place. No redeploy.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://accuknox.com/platform/agentz/assets/video/card-signed-trace.mp4"><img src="https://accuknox.com/platform/agentz/assets/video/card-signed-trace.jpg" alt="Reading a full trace in AgentZ" width="100%"></a>
<b>Read a full trace</b><br>
Inspect every span, every model call and every tool call, down to the token.
</td>
<td width="50%" valign="top">
<a href="https://accuknox.com/platform/agentz/assets/video/runtime-traces-telemetry.mp4"><img src="https://accuknox.com/platform/agentz/assets/video/runtime-traces-telemetry.jpg" alt="Runtime telemetry in AgentZ" width="100%"></a>
<b>Runtime in full view</b><br>
Every egress by domain, port and protocol, allowed or blocked, and recorded.
</td>
</tr>
</table>

## Take the tour

Ten real screens, in the order a new user meets them.

<table>
<tr>
<td width="50%" align="center"><img src=".github/assets/tour/slide-01.webp" alt="AgentZ title slide" width="100%"><br><b>01. Zero Trust Agentic AI Platform</b></td>
<td width="50%" align="center"><img src=".github/assets/tour/slide-02.webp" alt="Model picker with GLM, Claude, Gemini, Kimi and GPT" width="100%"><br><b>02. Any LLM, in a sandbox with memory</b></td>
</tr>
<tr>
<td width="50%" align="center"><img src=".github/assets/tour/slide-03.webp" alt="Sandbox update screen with per-tool toggles" width="100%"><br><b>03. Fine grained sandbox permissions</b></td>
<td width="50%" align="center"><img src=".github/assets/tour/slide-04.webp" alt="MCP connection form with Slack, GitHub, Notion and Linear" width="100%"><br><b>04. MCP server support</b></td>
</tr>
<tr>
<td width="50%" align="center"><img src=".github/assets/tour/slide-05.webp" alt="A cloud asset count diff report generated by an agent" width="100%"><br><b>05. Workflow runs, from chat</b></td>
<td width="50%" align="center"><img src=".github/assets/tour/slide-06.webp" alt="Schedule editor with a cron expression and run history limits" width="100%"><br><b>06. Crons and schedules</b></td>
</tr>
<tr>
<td width="50%" align="center"><img src=".github/assets/tour/slide-07.webp" alt="Workflow run graph with a step inspector" width="100%"><br><b>07. Live workflow graph</b></td>
<td width="50%" align="center"><img src=".github/assets/tour/slide-08.webp" alt="Span list with model calls, bash and webfetch" width="100%"><br><b>08. Logs and traces, span by span</b></td>
</tr>
<tr>
<td width="50%" align="center"><img src=".github/assets/tour/slide-09.webp" alt="Graph of MCP tools called by an agent" width="100%"><br><b>09. MCP tool usage, profiled</b></td>
<td width="50%" align="center"><img src=".github/assets/tour/slide-10.webp" alt="AccuKnox and AgentZ closing slide with certifications" width="100%"><br><b>10. See it for yourself</b></td>
</tr>
</table>

## How it works

### The shape of the platform

```mermaid
graph TB
    subgraph Sandbox["Agent Sandbox"]
        A1[Agent 1] --> CNP1[Cilium Network Policy<br/>Default-Deny]
        A2[Agent 2] --> CNP2[Cilium Network Policy<br/>Default-Deny]
        AN[Agent N] --> CNPN[Cilium Network Policy<br/>Default-Deny]
    end

    subgraph SecretInjection["Secret Injection Proxy"]
        SIP[MITM Proxy<br/>Intercepts, Rewrites,<br/>Resolves Secrets]
    end

    Sandbox --> SIP

    SIP --> OB[OpenBao<br/>Secrets never touch<br/>the agent]
```

### How one agent is boxed in

The controller writes a Cilium network policy for every agent it creates. The
policy allows DNS, the hosts the Sandbox lists, the telemetry endpoint, the MCP
gateway, and package downloads. It denies everything else.

```mermaid
graph TB
    subgraph Cluster["Kubernetes Cluster"]
        subgraph Namespace["Agent Namespace"]
            subgraph Pod["Agent Pod"]
                AC[Agent Container]
                SI[Sinjector Sidecar<br/>Port 4096]
            end

            CNP[CiliumNetworkPolicy]
        end

        subgraph Blocked["Blocked Traffic"]
            B1[No Internet Access]
            B2[No Other Namespaces]
            B3[No P2P Pod Communication]
        end

        subgraph Allowed["Allowed Traffic"]
            DNS[kube-dns<br/>Port 53]
            AH[Allowed Hosts]
            TE[Telemetry Endpoint]
            GW[MCP Gateway]
            PKG[Package Downloads]
        end
    end

    AC --> SI
    SI --> CNP
    CNP --> DNS
    CNP --> AH
    CNP --> TE
    CNP --> GW
    CNP --> PKG

    CNP -.->|Denies| Blocked
    CNP -.->|All Other| B1
    CNP -.->|All Other| B2
    CNP -.->|All Other| B3
```

### How a secret reaches an upstream service

The agent holds a placeholder such as `agentz:resolve:env:api-key`. The sinjector
sidecar swaps that placeholder for the real value outside the agent. A prompt
injection cannot leak a credential the agent never received.

<p align="center">
  <img src=".github/assets/diagrams/secret-injection.webp" alt="AgentZ secret injection sequence: the agent sends a placeholder, the injection proxy resolves it against the secret store, and the external tool receives the real secret" width="820">
</p>

### How the objects nest

A tenant contains workspaces. A workspace contains users, models and agents. An
agent owns the workflows that run inside it, and the sandboxes those workflows
execute in. The console calls a tenant an organization.

<p align="center">
  <img src=".github/assets/diagrams/hierarchy.webp" alt="AgentZ object hierarchy: a tenant holds workspaces, a workspace holds users, models and one agent, and the agent holds workflows, sub-agents and sandboxes" width="820">
</p>

An agent is a compute allocation, and not a wrapper around one. Everything an
agent owns is scoped by that allocation.

| Relationship | Type | What it means |
| --- | --- | --- |
| Tenant to Workspace | 1:N | Many workspaces per tenant, commonly one per department |
| Workspace to Agent | 1:N | A workspace owns its users, models and agents |
| Agent to Compute | 1:1 | The agent is the compute allocation |
| Agent to Workflow | 1:N | Workflows are owned by, and run inside, an agent |
| Agent to Sub-agent | 1:N | A main agent fans out to sub-agents that run in parallel |
| Agent to Sandbox | 1:N | Sandboxes are configured under the agent |
| Session to Workflow | N:N | Chat is global, and not scoped to a single workflow |
| Compute to Workflow | 1:N, shared | Concurrent workflows share the agent compute. CPU throttling handles contention. |

### Who sees what

The super admin configures the shared resources once. Everyone else inherits
capability through a role. A team such as HR uses the connectors without reading
or editing the MCP configuration behind them.

<p align="center">
  <img src=".github/assets/diagrams/roles.webp" alt="AgentZ role inheritance: a super admin configures shared credentials, environments and workflows once, and security, DevOps and data roles inherit the capability" width="640">
</p>

### What a workflow is made of

Four parts, and you configure them in this order. Inputs carry a JSON schema.
Steps are skills that run in sequence or in parallel. Triggers start the run.
Outputs come back when it finishes.

<p align="center">
  <img src=".github/assets/diagrams/workflow-anatomy.webp" alt="The four parts of an AgentZ workflow: inputs with a JSON schema and triggers feed the steps, and the steps produce outputs" width="860">
</p>

### How one workflow uses the platform

A workflow draws on five things at once. Naming them in order is the fastest way
to say what AgentZ does.

<p align="center">
  <img src=".github/assets/diagrams/workflow-execution.webp" alt="One AgentZ workflow end to end: a trigger starts the workflow, skills run on the agent inside a sandbox, credentials arrive at runtime, and every call lands in the trace" width="900">
</p>

Read the chain from the right and it is a security story. Nothing reaches a tool
without passing the sandbox. No credential exists inside the agent. Nothing
happens without landing in the trace.

### How a tool call is decided

Permission is set for each individual tool call, and not for the connector as a
whole. Read and scan can pass while mutate, push and delete stay denied.

<p align="center">
  <img src=".github/assets/diagrams/tool-permissions.webp" alt="AgentZ tool permission decision: each call is Always Allow, Needs Approval or Blocked, and every branch ends in the trace" width="680">
</p>

Every branch ends in the trace, including the blocked one. A denied call is
evidence, and not a silent no-op.

## Platform components

| Component | Purpose |
| --- | --- |
| Manager | Kubernetes operator that reconciles the Agent and Sandbox custom resources |
| Gateway | HTTP API for agents, secrets, sandboxes, workflows and observability data |
| Sinjector | Sidecar proxy that performs secret injection over MITM |
| Observer | Collects telemetry from KubeArmor, Hubble and OTLP sources |
| Extauth | External authorization service that brokers OpenBao access |
| Web | Next.js console for the whole platform |

Each component ships as a subcommand of one binary.

```bash
go run ./cmd/agentz --help
```

| Subcommand | What it starts |
| --- | --- |
| `gateway serve` | The HTTP API |
| `observer serve` | The telemetry collector |
| `sinjector serve` | The secret injection proxy |
| `extauth serve` | The external authorization service |
| `filesystem serve` | The agent filesystem service |
| `skill` | Skill management commands |
| `workflow` | Workflow management commands |

## Custom resources

The manager reconciles eleven custom resources in the `agentz.accuknox.com`
group, version `v1alpha1`.

| Kind | What it holds |
| --- | --- |
| `Agent` | One compute allocation, its model provider, skills and memory |
| `Sandbox` | Allowed hosts, packages and the resource limits an agent runs under |
| `Skill` | A reusable, versioned step |
| `WorkflowSchedule` and `WorkflowRun` | Cron triggers and the record of each execution |
| `MCPConnection` | One connected MCP server and its per-tool permissions |
| `Secret` | A secret reference resolved at request time, never a value |
| `InferenceProvider` | A model vendor and its credentials |
| `InferencePool` | A group of providers an agent can draw from |
| `Tenant` | The top-level isolation boundary |
| `Workspace` | A team boundary inside a tenant |

Read the generated schemas under
[`deploy/helm/charts/manager/crds/`](deploy/helm/charts/manager/crds/).

## Quick start

### Run the hosted platform

Sign up at [agentzharness.ai](https://agentzharness.ai/). Signing up creates an
organization and makes you its super admin. The free tier gives you two users,
one workspace, and one small agent at 1 vCPU and 1 GB RAM.

Five steps take you to a first run.

1. Sign up and land in your new organization.
2. Create a workspace. Pick General or AI-SOC.
3. Connect an integration over OAuth. Set each tool to Blocked, Needs Approval, or Always Allow.
4. Add a skill, wire the steps, and run the workflow from chat, the API, the CLI or a schedule.
5. Open the run graph and read every model call and tool call in order.

The [Quick Start](https://docs.agentzharness.ai/) walks through each step.

### Self-host on your own cluster

You need a Kubernetes cluster with Cilium, plus `kubectl`, `kustomize` and
`controller-gen`.

```bash
git clone https://github.com/accuknox/agentZ && cd agentZ
```

Install the custom resource definitions first.

```bash
make install
```

Then deploy the manager and the rest of the control plane.

```bash
make deploy
```

To produce a single manifest instead of applying directly, run
`make build-installer`. It writes `dist/install.yaml`.

Helm charts live under [`deploy/helm/`](deploy/helm/). Four subcharts cover the
gateway, the manager, the observer and the web console.

```bash
helm install agentz ./deploy/helm --namespace agentz --create-namespace
```

To remove everything, run `make undeploy` and then `make uninstall`.

### Attach the OpenCode client

Each agent sandbox runs an OpenCode server. The Gateway OpenCode API is fully
interoperable with the OpenCode TUI client.

```bash
opencode attach https://gw.agentz.accuknox.com/api/opencode/{AGENT_NAME}/
```

## Local development

The repository ships a Nix flake with every tool pinned.

```bash
nix develop
```

Without Nix, install Go 1.26, Bun, `sqlc`, `oapi-codegen`, `controller-gen`,
`golangci-lint`, `yamlfmt`, `yamllint` and `setup-envtest` yourself.

| Command | What it does |
| --- | --- |
| `make generate` | Regenerates SQL, OpenAPI clients, deepcopy code, CRDs and RBAC |
| `make fmt` | Formats Go, YAML and the two TypeScript workspaces |
| `make lint` | Runs `go vet`, `golangci-lint`, `yamllint` and the web type checks |
| `make test` | Runs the Go tests against envtest with a coverage profile |
| `make build` | Builds every Go package |
| `make all` | Runs generate, lint and build in order |

Run the control plane locally, one process per terminal.

```bash
make run-manager
```

```bash
make run-gateway
```

```bash
make run-observer
```

```bash
make run-extauth
```

Each target takes overrides as make variables. `POSTGRES_DSN`, `K8S_NAMESPACE`,
`IMAGE` and `AGENT_IMAGE` are the ones you change most often.

```bash
make run-gateway POSTGRES_DSN="postgresql://user:pass@localhost:5432/agentz"
```

Run `make generate` after you touch `openapi/gateway.yaml`, any file under
`pkg/apis/`, or an SQL query. The generated code is committed, so a pull request
with stale output fails review.

## Repository layout

```text
agentZ/
├── cmd/agentz/            One binary, one subcommand per component
│   └── subcommands/       gateway, observer, sinjector, extauth,
│                          filesystem, skill, workflow
├── internal/              The implementation of each component
│   ├── controller/        Reconcilers for the eleven custom resources
│   ├── gateway/           HTTP API handlers
│   ├── sinjector/         The MITM secret injection proxy
│   ├── observer/          Telemetry collection
│   ├── networkpolicy/     Cilium policy generation
│   ├── openbao/           Secret store client
│   ├── mcp/               MCP connector handling
│   ├── skill/             Skill storage and versioning
│   └── workflow/          Workflow execution and scheduling
├── pkg/apis/agentz/       The v1alpha1 API types
├── pkg/controller/        Generated clientsets, informers and listers
├── deploy/
│   ├── helm/              Four subcharts: gateway, manager, observer, web
│   └── kustomize/         CRDs, RBAC, webhooks and the default overlay
├── web/                   Next.js 16 console, React 19, Drizzle, Better Auth
├── opencode/              OpenCode config, skills and the OTel plugin
├── openapi/               The Gateway API specification
├── hack/                  Code generation scripts and the Nix agent init
├── docs/                  Design notes on the security model
└── flake.nix              The pinned development environment
```

## How AgentZ compares

Researched in July 2026 from vendor documentation and public reporting. This
category moves fast, so check the sources before you quote the table.

| Capability | AgentZ | LangGraph | CrewAI AMP | Microsoft Foundry | AWS AgentCore | n8n |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Zero trust, default deny | Yes | No | Partial | Partial | Partial | No |
| Network egress control | Yes | No | No | Partial | Partial | No |
| Zero secret exposure | Yes | No | Partial | Partial | Partial | No |
| Fine-grained access control | Yes | Partial | Partial | Partial | Partial | Partial |
| Full audit trail | Yes | Partial | Partial | Partial | Partial | Partial |
| Multi-user and roles | Yes | Yes | Yes | Yes | Yes | Yes |
| On-premises | Yes | Partial | No | Partial | No | Yes |
| Air-gapped | Yes | No | No | No | No | Partial |
| Model agnostic | Yes | Yes | Yes | Partial | Partial | Yes |
| Dynamic skill creation | Yes | No | No | Partial | No | No |
| Single control plane | Yes | Partial | Partial | Partial | Partial | Partial |

The full grid, with a note behind every mark, sits on the
[product page](https://accuknox.com/platform/agentz/).

## Deployment options

| Option | What it means |
| --- | --- |
| SaaS | Cloud-hosted and multi-tenant. The fastest path to a first run. |
| On-premises | Runs on your own cluster. Manager, gateway, sinjector and observer deploy together. |
| Air-gapped | Runs with no internet connectivity. AgentZ makes no outbound calls. |
| Bring your own model | OpenAI, Anthropic, Google, Grok or a self-hosted endpoint, on your key. No markup and no proxy in the path. |

Four components deploy together on a self-hosted cluster. The gateway serves the
API, the manager reconciles the custom resources, the sinjector injects secrets,
and the observer collects telemetry.

<p align="center">
  <img src=".github/assets/diagrams/self-hosted-architecture.webp" alt="Self-hosted AgentZ layout: the gateway feeds the manager, the manager runs agent sandboxes under a default-deny network policy, the sinjector reaches the secret store, and the observer reports back to the gateway" width="600">
</p>

Credentials and policy live on AgentZ rather than on the agent. Switching model
does not mean re-wiring credentials or scopes.

## Documentation

| Page | What it covers |
| --- | --- |
| [Quick Start](https://docs.agentzharness.ai/) | Sign up to first run, in five steps |
| [The AgentZ Mental Model](https://docs.agentzharness.ai/mental-model/) | One hierarchy that explains the platform |
| [Core Concepts](https://docs.agentzharness.ai/core-concepts/) | Agents, workflows, skills, sandboxes, credentials, workspaces, triggers |
| [Setting Up Your Sandbox](https://docs.agentzharness.ai/sandbox/) | Compute size, domain allowlisting, packages, filesystem |
| [Connecting Integrations](https://docs.agentzharness.ai/integrations/) | MCP connectors, OAuth, and the three permission levels |
| [Building and Managing Skills](https://docs.agentzharness.ai/skills/) | Write one, upload one, or describe the job |
| [Creating Workflows](https://docs.agentzharness.ai/workflows/) | Inputs, steps, triggers, outputs and the visual graph |
| [Governance and Security](https://docs.agentzharness.ai/governance/) | Zero secret exfiltration, approval gates, the audit trail |
| [Deployment Options](https://docs.agentzharness.ai/deployment/) | SaaS, on-premises, air-gapped, bring your own model |
| [Playbooks](https://docs.agentzharness.ai/playbooks/) | Three workflows to copy, written out click by click |

Design notes on the security model live in this repository.

- [Agent Sandbox](./docs/agent-sandbox.md)
- [Secret Injection](./docs/secret-injection.md)
- [Sandboxes](./docs/sandboxes.md)
- [OpenCode Interoperability](./docs/opencode.md)

## FAQ

<details>
<summary><b>Does AgentZ run in our cloud or yours?</b></summary>

Standard tiers run on shared cloud. Enterprise gets VPC, on-premises or
air-gapped deployment with a private tenant. The sandbox policy engine runs local
to the agents in every case. It is a kernel-level check, and not a remote proxy
deciding over the wire.

</details>

<details>
<summary><b>What stops an agent from calling an API it should not?</b></summary>

The sandbox enforces a default-deny network policy. Cilium checks every outbound
call against an explicit allowlist before the packet leaves. A blocked call lands
in the audit trace with the domain and the port it tried to reach.

</details>

<details>
<summary><b>Will it work with the model and framework we already use?</b></summary>

Yes. AgentZ accepts any model provider on your own key, including OpenAI,
Anthropic, Google and a self-hosted endpoint. Wrap an existing LangGraph or
CrewAI agent, or build skills natively. The governance layer sits underneath
either way.

</details>

<details>
<summary><b>How does the audit trail hold up in a compliance review?</b></summary>

Every tool call, memory read and model response is recorded with a deterministic
replay id. An auditor can replay any run exactly as it happened. Egress is
recorded by domain, port and protocol, allowed or blocked.

</details>

<details>
<summary><b>What is on the free tier?</b></summary>

Two users, one workspace, and one small agent at 1 vCPU and 1 GB RAM. Bring your
own model subscription or key. SSO covers GitHub, Google and Microsoft. Prompt
guardrails run on platform defaults.

</details>

<details>
<summary><b>Why does the agent need a proxy in the path?</b></summary>

The sinjector is how the agent stays free of secrets. It intercepts TLS with a CA the agent
trusts and finds the placeholder. It resolves that placeholder against OpenBao
and forwards the real value. The agent process never holds the credential.

</details>

<details>
<summary><b>Can I run the OpenCode TUI against an AgentZ agent?</b></summary>

Yes. Each sandbox runs an OpenCode server, and the Gateway API is fully
interoperable with the OpenCode client. Run
`opencode attach https://gw.agentz.accuknox.com/api/opencode/{AGENT_NAME}/`.

</details>

## Contributing

Pull requests are welcome. Follow these steps.

1. Fork the repository and create a branch off `main`.
2. Enter the development shell with `nix develop`.
3. Make your change. Run `make generate` if you touched an API, a CRD or a query.
4. Run `make lint` and `make test`. Both must pass.
5. Open a pull request that explains the change and how you tested it.

Keep commit messages in the conventional style this repository already uses, for
example `fix(workspace): validate cilium policies locally`.

## Contributors

<a href="https://github.com/accuknox/agentZ/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=accuknox/agentZ" alt="AgentZ contributors">
</a>

Built by the team at [AccuKnox](https://accuknox.com).

## Security

Report a vulnerability privately to <security@accuknox.com>. Do not open a public
issue for a security problem.

AgentZ is a security product. A finding in the sandbox, the network policy
generator or the sinjector gets priority handling.

## License

Apache License 2.0. See [LICENSE](LICENSE).

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/brand/agentz-lockup-ondark.svg">
  <img src=".github/assets/brand/agentz-lockup.svg" alt="AgentZ" width="200">
</picture>

<p>
<a href="https://agentzharness.ai/"><b>Start free</b></a> ·
<a href="https://www.youtube.com/watch?v=mAzLWcr59g0"><b>Watch the demo</b></a> ·
<a href="https://accuknox.com/platform/agentz/"><b>Product page</b></a> ·
<a href="https://docs.agentzharness.ai/"><b>Docs</b></a>
</p>

<a href="https://www.producthunt.com/products/agentz?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-agentz" target="_blank" rel="noopener noreferrer"><img alt="AgentZ on Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1216150&theme=light&t=1787120477230"></a>

<p>If AgentZ is useful to you, star the repository. It helps other teams find it.</p>

<a href="https://star-history.com/#accuknox/agentZ&Date">
  <img src="https://api.star-history.com/svg?repos=accuknox/agentZ&type=Date" alt="Star history" width="600">
</a>

</div>
