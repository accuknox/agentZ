# Organisation and Workspace Manual Acceptance

Date: 2026-08-16

## Environment

- Branch: `feat/org-support`
- UI: production Next.js build running directly on the host
- Gateway, manager, external authorizer, and observer: current host binaries
- Persistence: PostgreSQL 18.4 and the configured OpenBao and S3 services
- Runtime: local kind cluster with Cilium, Hubble, KubeArmor, cert-manager,
  and the AgentZ CRDs

## Final Cleanup Verification

- The consolidated migration applied to an empty disposable database. The
  resulting schema contained 38 public tables and nine migration journal
  entries, with no legacy cutover or slug-history tables.
- Database constraints rejected mutable Organisation slugs, incomplete failed
  Workspace states, cross-Organisation Role assignments, invalid permission
  resources and actions, targetless Agent shares, and invalid cleanup jobs.
- Two email/password signups each created exactly one personal Organisation
  and immutable Superadmin Role assignment.
- The first User created a Workspace, custom read-only Role, Team, and bearer
  Invitation through the production UI. The Workspace reconciled to Ready and
  its built-in Workspace Admin Role remained immutable.
- Member and Team effective-access graphs rendered their grant paths and
  textual tables. Restricting either graph to a Workspace with no applicable
  grants produced the explicit no-access state.
- A differently addressed signed-in User accepted the bearer Invitation. The
  transaction created one Membership, assigned the selected direct Role,
  marked the Invitation accepted, and recorded one successful Event Trail
  Event. Reusing the link returned the one-time unavailable state.
- Disabling that Membership set `disabled_at`, completed the durable cleanup
  job in one attempt, and recorded a successful event. The disabled User could
  still use their personal Organisation, while direct navigation to the
  disabled Organisation showed the disabled-membership state.
- The manager reported healthy and ready while reconciling the Tenant and
  Workspace. Workspace RBAC, storage, certificate, and Cilium resources were
  present. The observer connected to Hubble and both KubeArmor streams and
  consumed live events without errors.
- The gateway returned structured unauthenticated errors and accepted tokens
  from the production UI. The external authorizer passed health checks with a
  locally available OpenBao role; the repository default role was absent from
  this development OpenBao instance.
- Every dummy database and Kubernetes fixture was removed afterward. The
  integration database returned to its original one Organisation, one User,
  and zero Workspace state, and all host processes, browser state, temporary
  files, and the disposable database were removed.

## Release Checks

- Go formatting, vet, lint, modernisation checks, tests, and builds passed.
- Web and OpenCode linting and TypeScript checks passed.
- The production Next.js build compiled all routes successfully.
- SQL, OpenAPI, Zod, deep-copy, CRD, RBAC, and webhook generation was
  idempotent. Drizzle reported a valid migration history.
- Static dead-code analysis reported only the conventional public Kubernetes
  `Kind` helper. Frontend analysis reported only framework entry points,
  Better Auth configuration, and generated OpenAPI exports.

## Previously Established Coverage

The broader Organisation feature acceptance remains recorded here because the
cleanup did not change these contracts:

- GitHub and Google controls initiated authorization with their providers.
  Callback completion requires interactive external test identities.
- Switching Organisations changed the gateway `organization_id` claim without
  leaking access to another Organisation. Insufficient Workspace authority was
  denied with HTTP 403.
- Direct and Team grants resolved as a union. Permission dependencies, creator
  authority, Superadmin bypass, Workspace Admin non-escalation, Agent
  ownership, sharing, transfer, and cross-Workspace isolation were exercised.
- Agent API-key creation, valid and invalid Basic authentication, proxy target
  authorization, and immediate browser revocation were exercised.
- Same-Workspace network traffic succeeded and cross-Workspace traffic was
  denied. Workspace-scoped OpenBao access reached the secret path; an
  intentionally incomplete inference-provider fixture correctly prevented the
  test Agent from becoming ready.
- Role impact preview and save, cleanup retry state transitions, invitation
  concurrency, expired links, and disabled-member behavior were exercised.

## Visual and Accessibility Review

- Populated Users, Roles, effective Access, API Keys, invitation, zero-access,
  and impact-preview states were reviewed in light and dark themes at desktop,
  tablet, and mobile widths.
- Tables remained horizontally available on mobile, icon controls had labels,
  keyboard-operated dialogs and menus worked, and the effective-access graph
  retained an equivalent textual summary.
- Axe reported no critical or serious findings on the populated Users surface.
  Its sole moderate finding concerned table fragments already named and
  contained by the page's main landmark.

## Scope Confirmation

GitHub user-ID invitations, SCIM, IdP group synchronization,
cross-Organisation sharing, custom denial rules, billing, and the other
exclusions in CNAPP-30739 were not added during acceptance.
