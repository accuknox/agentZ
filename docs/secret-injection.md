# Secret Injection

AgentZ implements a zero-trust secret management model where agent
containers never receive secret values directly. Instead, a per-agent proxy
(sinjector) intercepts outbound requests, resolves secret references from
OpenBao, and injects the actual values before forwarding traffic to upstream
services.

## Problem Statement

Traditional approaches to secret management in AI agents have a fundamental
flaw: the agent needs access to secrets (API keys, tokens, credentials) to
make authenticated requests to external services. This creates risk:

- The agent's runtime sandbox contains sensitive credentials
- If the agent is compromised, all secrets are exposed

AgentZ eliminates this attack surface by removing secrets from the agent
container entirely.

## Architecture

The secret injection system consists of three components:

```mermaid
sequenceDiagram
    participant Agent as Agent Container
    participant Proxy as Sinjector Sidecar
    participant OpenBao as OpenBao
    participant Upstream as Upstream Service

    Note over Agent: ENV: OPENAI_API_KEY<br/>= agentz:resolve:env:api-key

    Agent->>Proxy: HTTP Request<br/>Authorization: Bearer<br/>agentz:resolve:env:api-key

    Note over Proxy: Intercept TLS<br/>Decrypt with CA cert

    Proxy->>OpenBao: Resolve secret<br/>Path: secret/data/{agent}/api-key
    OpenBao->>Proxy: {value: "sk-...", hosts: ["api.openai.com"]}

    Note over Proxy: Rewrite placeholder<br/>with actual value

    Proxy->>Upstream: Request (real API key)
    Upstream->>Proxy: Response
    Proxy->>Agent: Response
```

The sinjector is a sidecar container running alongside the agent. It
implements an HTTP proxy with man-in-the-middle (MITM) capabilities:

1. **Certificate Management**: The proxy presents a dynamically-generated TLS
   certificate signed by a CA that AgentZ manages. The agent trusts this CA
   implicitly because the CA bundle is mounted into the agent's trust store.
2. **Request Interception**: The agent container is configured to use the
   sinjector as its HTTP/HTTPS proxy. All outbound traffic flows through the
   proxy.
3. **Placeholder Rewriting**: The proxy scans request headers, query
   parameters, and URL paths for secret placeholders in the format
   `agentz:resolve:env:{secret-name}`.
4. **Secret Resolution**: When a placeholder is found, the proxy fetches the
   corresponding secret from OpenBao using the agent's Kubernetes service
   account identity.
5. **Host Validation**: Each secret in OpenBao includes a `hosts` field that
   specifies which destinations can receive that secret. If the request target
   is not in the allowed list, the placeholder is left unresolved (the request
   fails).
6. **Request Forwarding**: After rewriting, the proxy establishes a new TLS
   connection to the upstream service using its own certificate, and forwards
   the modified request.

## Subscription inference credentials

OpenAI Codex and GitHub Copilot credentials use the same boundary without
entering an Agent pod or Kubernetes Secret. The gateway stores a short-lived,
identity-bound OAuth ticket in OpenBao, consumes it once with check-and-set,
and moves the typed credential record to the subscription path. API responses
contain only the opaque ticket and provider metadata; credential fields are
write-only and are never read back through the API.

The gateway OpenBao role must be able to create, read, update, and delete data
under its inference OAuth-ticket and subscription-credential subtrees. It also
configures and deletes OAuth-ticket metadata so OpenBao expires abandoned
tickets automatically. Read access is required for single-use ticket CAS and
must not be exposed by an API handler. The manager creates a namespace-scoped
extAuth role that can read subscription credentials and update only refreshed
tokens. API-key and cloud-provider credentials stay in a separate subtree that
extAuth cannot read.

For the default `kv` mount, keep the gateway's general write policy segmented
so the longer inference paths win OpenBao's wildcard priority rules:

```hcl
path "kv/data/+/*" {
  capabilities = ["create", "update", "delete"]
}

path "kv/metadata/+/*" {
  capabilities = ["delete"]
}

path "kv/metadata/+/inference-provider-oauth-tickets/*" {
  capabilities = ["create", "update", "delete"]
}

path "kv/data/+/inference-provider-oauth-tickets/*" {
  capabilities = ["create", "read", "update", "delete"]
}

path "kv/data/+/inference-subscriptions/*" {
  capabilities = ["create", "read", "update", "delete"]
}
```

AgentGateway calls extAuth before an authenticated subscription request reaches
the upstream. A controller-owned route overwrites the Sandbox identity header,
Cilium restricts that route path to the bound Agent, and extAuth verifies the
Sandbox-to-provider or Sandbox-to-Pool relationship. extAuth removes the
internal identity header after injecting the upstream authorization headers.
