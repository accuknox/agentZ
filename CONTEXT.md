# AgentZ

AgentZ governs access to isolated AI-agent resources shared by people within
organisations and workspaces.

## Tenancy and membership

**Organisation**:
The top-level product tenant and governance scope. An Organisation may contain
members, Teams, Workspaces, and shared resources.
_Avoid_: Tenant, account

**Organisation Membership**:
One User's enabled or disabled membership in one Organisation. It does not own
the User or affect the User's memberships in other Organisations.
_Avoid_: User account, Organisation User

**Workspace**:
An isolated product-resource scope within one Organisation. An Organisation may
contain zero or more Workspaces.
_Avoid_: Project, Tenant

**Team**:
A named group of active Organisation Members that receives Roles and Agent
Shares as a unit.
_Avoid_: Group

## Authorisation

**Role**:
A reusable, stable-identity collection of scoped Permission Grants. A Role has
a mutable display name that is never its authorisation identity.
_Avoid_: Permission set, access level

**Organisation Role**:
A Role governed at Organisation scope whose grants may apply to the
Organisation and selected Workspaces.
_Avoid_: Global Role

**Workspace Role**:
A Role permanently local to one Workspace.
_Avoid_: Project Role

**Superadmin**:
The immutable system Role that grants full authority throughout one
Organisation. An Organisation may have several Superadmins.
_Avoid_: Owner, administrator

**Workspace Admin**:
The immutable system Role that grants full resource and administration authority
within one Workspace.
_Avoid_: Workspace Owner, Project Admin

**Permission Grant**:
An allow-only capability for one resource action in one Organisation or
Workspace scope.
_Avoid_: Permission, ACL entry

**Effective Permission**:
A User's resulting capability after combining applicable direct Roles, Team
Roles, and defined implicit authorities.
_Avoid_: Access level

## Agent collaboration

**Agent Owner**:
The User with durable full control of one Agent while retaining independent
access to the Agent's Workspace.
_Avoid_: Creator, author

**Agent Share**:
An explicit, capability-limited grant on one Agent to a User or Team.
_Avoid_: Agent Role, direct permission

## Admission, inheritance, and operations

**Social Admission Policy**:
The per-Organisation Google and GitHub rules used only when social sign-up
creates an Organisation Membership.
_Avoid_: SSO policy, login policy

**Inherited Organisation Resource**:
An individually selected Organisation resource exposed read-only within one
Workspace.
_Avoid_: Shared resource, copied resource

**Audit Event**:
An immutable, scoped record of an attempted mutation and its result, actor,
target, and safe before-and-after summary.
_Avoid_: Log entry, activity

**Destructive Operation**:
A durable operation that records immediate access revocation and tracks
eventual cleanup across AgentZ's resource stores.
_Avoid_: Delete request, cleanup task
