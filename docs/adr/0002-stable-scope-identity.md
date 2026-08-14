# Use immutable IDs for scope identity

Organisation and Workspace identity, Kubernetes namespace identity, resource
references, and authorisation use immutable IDs rather than display names or URL
slugs. Names may change. Organisation slugs are immutable; Workspace slugs may
change, but every historical Workspace slug remains reserved and redirects to
the current route. This keeps isolation and authority stable while making an
Organisation's URL identifier permanent.
