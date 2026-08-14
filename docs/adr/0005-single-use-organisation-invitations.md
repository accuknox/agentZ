# Use single-use Organisation Invitation capabilities

Better Auth's native Organisation Invitation binds acceptance to an email
address, but AgentZ invitations intentionally grant eligibility to any signed-in
User holding the link. AgentZ therefore extends Better Auth with a server-only
plugin endpoint and plugin-owned generated model while retaining Better Auth's
session middleware, Organisation, Membership, Role, Team, and ID primitives.
The extension stores only a SHA-256 token digest, consumes the invitation in the
same PostgreSQL transaction that creates its Membership and assignments, and
keeps AgentZ-specific Role, Team, and Event Trail writes inside that transaction.
