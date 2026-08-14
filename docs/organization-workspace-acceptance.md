# Organisation and Workspace Manual Acceptance

Date: 2026-08-14

## Environment

- Branch: `feat/org-support`
- UI: production Next.js build on the host
- Gateway, manager, and observer: host processes started through the Makefile
- Persistence: disposable PostgreSQL bound to `127.0.0.1`, OpenBao in kind,
  and the configured S3-compatible bucket
- Runtime: local kind cluster with Cilium, Hubble, KubeArmor, cert-manager,
  AgentZ CRDs, and existing Agent and Sandbox fixtures

## Representative scopes

- Alice: Superadmin of `GmfasdeRIiDyJmEz4Urqs2Eo1O15khOf`
- Bob: member of two Organisations and Workspace Admin of
  `workspace-c9b6d0a4-8e75-4063-a63f-53c605a933e2`
- Zero: accepted a grant-free Role, then had that Membership disabled
- Workspace namespace: `knox-50150497a9448e64c4c4efe733fd8380`
- Agent: `acceptance-agent`

## Results

- Direct email/password signup created one governed personal Organisation and
  immutable Superadmin assignment. Every signup retains that Organisation even
  when the User continues through an Organisation Invitation.
- A signed-in User accepted a bearer Organisation Invitation despite having a
  different email address. Two concurrent acceptance attempts produced one
  Membership and one unavailable result; the transaction also assigned the
  selected direct Role and Team, activated the Organisation session, and wrote
  one Event Trail Event. A current Member and a disabled Member did not consume
  later links, while an expired link was unavailable. All test fixtures were
  removed after verification.
- GitHub and Google signup controls initiated authorization at `github.com` and
  `accounts.google.com`. Provider callbacks were not completed because this
  local run did not have interactive external identities for the test users.
- Bob switched between two Organisations. Fresh gateway tokens changed the
  `organization_id` claim to the selected stable ID without leaking the other
  Organisation. A Workspace Admin Organisation token was denied Workspace
  creation with HTTP 403.
- Direct and Team grants were resolved as a union. Permission dependencies,
  creator authority, Superadmin bypass, Workspace Admin non-escalation, Agent
  ownership, sharing, and ownership transfer were exercised against gateway
  claims. Cross-Workspace Agent enumeration was denied.
- A grant-free Membership rendered the explicit no-Workspace-access screen.
  Disabling it produced a durable cleanup operation and the disabled scope was
  no longer selectable; the user's separate Organisation remained usable.
- An Agent API key was created in the browser for one Agent. Valid Basic auth
  passed credential and target authorization and reached the Agent proxy (502
  because the deliberately incomplete Agent fixture had no running upstream).
  An invalid key returned 401. Browser revocation caused the previously valid
  key to return 401 immediately.
- Tenant and Workspace resources reached Ready. Namespaces were derived from
  stable IDs. Workspace RBAC, PVCs, certificates, and Cilium policies existed.
  Same-Workspace HTTP traffic succeeded; cross-Workspace traffic timed out.
  Hubble and both KubeArmor streams connected to the host observer.
- The OpenBao and secret path was reached through a Workspace-scoped claim.
  Secret creation intentionally stopped at Agent readiness because the test
  Agent uses a nonexistent inference provider; no production fallback or
  direct-store write was introduced to hide that fixture failure.
- Cutover rejected missing maintenance/backup evidence. With explicit
  maintenance mode and four-store backup evidence, dry-run inventoried
  PostgreSQL, Kubernetes, OpenBao, and S3 and produced deterministic Default
  Workspace identities. Commit/resume behavior remains covered by the cutover
  integration tests; this already-contracted shared fixture was not mutated
  back into a legacy state solely to repeat a destructive migration.
- Role impact preview and save were completed in the browser. Membership
  disable and API-key revoke showed immediate authorization effects and durable
  cleanup state. Failure/retry state transitions remain covered by the gateway
  and cleanup integration suites.

## Visual And Accessibility Review

- Captured light and dark screenshots at 1440x1000, 900x1000, and 390x844 for
  populated Users, Roles, effective Access, and API Keys, plus invitation,
  zero-access, and impact-preview states.
- Tables remained horizontally available on mobile, icon controls had labels,
  keyboard-operated dialogs and menus worked, and reduced-motion classes were
  retained. The effective-access view exposes a textual summary alongside its
  graph.
- Axe reported no critical or serious findings on the populated Users surface.
  Its only finding was the moderate `region` rule for eight table fragments;
  the table is already named and contained by the page's main landmark, so no
  extra landmark wrappers were added around individual table content.
- Routed tabs, active states, density, typography, focus treatment, radii, and
  dark-mode tokens remained consistent with the existing AgentZ surfaces.

## Scope Confirmation

GitHub user-ID invitations, SCIM, IdP group synchronization, cross-Organisation
sharing, custom denial rules, billing, and the other exclusions in CNAPP-30739
were not added during acceptance.
