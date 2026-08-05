# Use immutable IDs for scope identity

Organisation and Workspace identity, Kubernetes namespace identity, resource
references, and authorisation use immutable IDs rather than display names or URL
slugs. Names and slugs may change, but every historical slug remains reserved
and redirects to the current route; this keeps isolation and authority stable
without making human-facing labels immutable.
