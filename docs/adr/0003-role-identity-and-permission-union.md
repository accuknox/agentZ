# Authorise through stable Role identities

Better Auth Role records have stable internal IDs and immutable opaque transport
keys. AgentZ owns their separate, scope-unique mutable display names; system
Roles also carry immutable machine-readable metadata. AgentZ grants only allow
capabilities through Roles and computes Effective Permission as the union of
direct and Team-derived Role assignments plus defined implicit authority, with
identical Role semantics regardless of assignment provenance. Display-name
comparisons, first-role-wins checks, and source-specific Role exclusions make
renames and multi-source access unsafe.
