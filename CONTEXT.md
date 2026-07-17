# Agentz

Agentz provides persistent workspaces and reusable instructions to autonomous
agents.

## Language

**Mutable Skill**:
A skill owned by one Agent whose contents may change without creating a version.
_Avoid_: Local skill, filesystem skill

**Immutable Skill**:
A shared, versioned skill whose published versions never change.
_Avoid_: Global skill, object-storage skill

**Agent Workspace**:
The persistent files and tools belonging to one Agent across executions.
_Avoid_: Agent home, sandbox storage

**Skill Import**:
The operation that validates one uploaded document or archive and adds its skills
to selected destinations according to explicit conflict decisions.
_Avoid_: Skill upload, skill copy
