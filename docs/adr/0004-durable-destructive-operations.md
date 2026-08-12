# Revoke access before cross-store cleanup

Destructive changes atomically record access revocation, an Event Trail Event, and a
durable Destructive Operation in PostgreSQL before idempotent cleanup proceeds
across Kubernetes, OpenBao, and S3. Event Trail Events retain safe summaries for a
rolling 30 days and survive Workspace cleanup, so temporary external failures
cannot preserve authority or erase the investigation trail.
