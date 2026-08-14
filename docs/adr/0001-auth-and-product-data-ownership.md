# Separate identity ownership from product authorisation

Better Auth owns accounts, sessions, Organisations, Organisation Memberships,
Teams, OAuth, reusable Role records, and JWT signing. AgentZ owns
Workspaces and the product-specific extensions that attach scope, grants, Team
Roles, Organisation Invitations, admission policy, Agent collaboration, event
trail, and cleanup semantics to those records. This boundary preserves Better
Auth's security-sensitive identity and session flows while allowing admission
and the multi-role, multi-scope union that its native Organisation plugin cannot
represent.

AgentZ assignment tables are authoritative for product access. The native Role
string is an immutable, Organisation-unique transport key because Better Auth
stores it in Member fields; the AgentZ extension owns the mutable, scope-unique
display name. Better Auth Role permission payloads remain inert. AgentZ resolves
capabilities from relational Permission Grants keyed by the native Role record's
stable ID.
