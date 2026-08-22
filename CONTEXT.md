# AgentZ

AgentZ lets people create agents, run reusable workflows, and inspect the data those agents publish inside an authorized Workspace.

## Language

**Dashboard**:
An agent-owned, Workspace-scoped view of retained workflow data.
_Avoid_: Report, board

**Dashboard definition**:
The versioned contract that names a Dashboard's dimensions, measures, filters, and widgets.
_Avoid_: Manifest, config

**Dashboard record**:
One retained observation published to a Dashboard by its owning Agent.
_Avoid_: Event, row, data point

**Dimension**:
A named string field used to group or filter Dashboard records.
_Avoid_: Tag, label field

**Measure**:
A named numeric field used in Dashboard aggregations.
_Avoid_: Metric field, value

**Widget query**:
A stored, closed query description attached to a Dashboard widget.
_Avoid_: SQL, expression
