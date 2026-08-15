# 0006: Evaluate authorization policy with Cedar

## Status

Accepted

## Context

AgentZ combines scoped custom Roles, direct and Team Role assignments, built-in
administrators, Agent ownership, and capability-limited User and Team shares.
PostgreSQL queries and endpoint-specific Go branches previously expanded these
relationships independently. The web application then inferred unrelated
access from coarse Workspace booleans. Enforcement, resource visibility, and
user interface visibility could therefore disagree.

Relationship stores such as SpiceDB and OpenFGA model this graph well, but
adopting either would divide authoritative access facts between PostgreSQL and
a second datastore. Role, Team, membership, and Agent Share mutations are
already transactional in PostgreSQL. There is no transaction spanning either
relationship store, so a migration would also require a durable outbox and a
defined consistency window for security-sensitive revocations.

Cerbos keeps policy outside the application but still requires AgentZ to
assemble the same relationship graph for every decision. Casbin can evaluate
the existing RBAC model in-process, but Agent ownership, capability-limited
shares, and compound Workspace prerequisites remain application-specific
matcher logic.

## Decision

PostgreSQL remains the only authority for authorization facts. Generated sqlc
queries load the relevant Role grants, ownership, direct shares, and Team
shares. The gateway evaluates their policy with the stable Cedar Go authorizer.
Cedar owns capability implication and compound decisions; stored Agent Share
grants remain exactly what the caller selected.

The gateway returns generated Capability Projections with Workspace and Agent
resources. Web code renders only those projections and never reads Role tables
or derives one capability from another. Gateway enforcement remains mandatory.

Static policies are parsed when the authorization package initializes. Policy
behavior is covered by authorization tests. Experimental Cedar Go schema and
batch packages are not runtime dependencies.

## Consequences

- Authorization facts participate in existing PostgreSQL transactions.
- Cedar centralizes default-deny Agent policy, ownership, delegated sharing,
  secret capability implication, and Workspace prerequisites.
- Resource lists and UI actions receive the same per-Agent decisions.
- No external authorization service, datastore, reconciliation controller, or
  dual-write failure mode is introduced.
- New authorization relationships require a sqlc fact projection, a Cedar
  policy change, and a generated API capability field.
- UI visibility remains advisory and cannot grant authority.
