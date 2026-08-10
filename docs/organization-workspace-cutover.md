# Organisation and Workspace cutover

This runbook moves every legacy Tenant namespace into its Organisation's
Default Workspace. Run it once for the production data set before deploying the
contracted application routes and authorization model.

## Preconditions

1. Deploy the release containing the `agentz cutover` command and database
   schema, but do not deploy the contracted gateway, manager, or web processes.
2. Confirm the Kubernetes context, PostgreSQL database, OpenBao mount, and S3
   bucket all identify the same environment.
3. Schedule maintenance and stop every AgentZ writer: web, gateway, manager,
   observer, external authorization service, Agents, and Workflow runners.
   Keep the Kubernetes API, PostgreSQL, OpenBao, and S3 available.
4. Take PostgreSQL, Kubernetes, OpenBao, and S3 backups from this stopped state.
   Restore each backup into an isolated location and verify it can be read.
5. Record the verified locations and SHA-256 digests in a manifest:

```json
{
  "postgresql": {"location": "...", "sha256": "...", "verified": true},
  "kubernetes": {"location": "...", "sha256": "...", "verified": true},
  "openbao": {"location": "...", "sha256": "...", "verified": true},
  "s3": {"location": "...", "sha256": "...", "verified": true}
}
```

Store the manifest outside the affected services. Do not put credentials in it.

## Dry run

Export the `AGENTZ_CUTOVER_*` variables shown by
`agentz cutover --help`, including `AGENTZ_CUTOVER_MAINTENANCE_MODE=true` and
the verified backup manifest path. Then run without `--commit`:

```sh
agentz cutover | tee /tmp/agentz-cutover-dry-run.json
```

The command must exit successfully. Review every Tenant's Organisation,
Default Workspace, target namespace, PostgreSQL row counts, Kubernetes object
and PVC inventory, OpenBao objects, S3 objects, and inventory hash. Resolve any
unexpected or ambiguous identity before continuing. Recreate the backups and
manifest if any writer ran after the backup was taken.

## Commit

Run the same binary and environment with the same verified manifest:

```sh
agentz cutover --commit | tee /tmp/agentz-cutover-commit.json
```

The command serializes cutovers with a PostgreSQL advisory lock and records a
durable checkpoint for each Organisation. It is safe to rerun the identical
command after interruption. Do not change the backup manifest or source data
between attempts. Completion requires every entry to report `activated`.

## Deployment order

1. Confirm all cutover entries are `activated` and retain maintenance mode.
2. Apply generated CRDs and RBAC, then deploy the contracted manager.
3. Wait for every Tenant and Default Workspace to report Ready.
4. Deploy the contracted gateway and wait for its health check.
5. Deploy the contracted web application and remaining services.
6. Start Agents and Workflow runners, then reopen user traffic.

Do not deploy the contracted web application or gateway before the migration
commit. They intentionally reject legacy JWTs and expose only scoped URLs.

## Verification

Verify before ending maintenance:

- each active account opens
  `/orgs/{orgSlug}/workspaces/{defaultWorkspaceSlug}`;
- recorded Organisation and Workspace slugs permanently redirect to their
  canonical scoped URL;
- Tenant and Workspace resources are Ready and use deterministic namespaces;
- migrated Agents, Workflows, Secrets, Skills, API keys, telemetry, OpenBao
  data, and S3 objects are available only in the Default Workspace;
- a second `agentz cutover --commit` returns the same activated inventory;
- legacy scope-less URLs and JWTs are rejected;
- gateway authorization reflects Role or Team revocation immediately.

Retain the verified backups, manifest, and both reports until the agreed
post-cutover observation period ends.

## Recovery boundaries

Before the `sql` checkpoint, source data remains authoritative. Keep writers
stopped, correct the external failure, and rerun the same commit command; copied
target data is verified before activation.

The SQL activation is one transaction. At or after the `sql` checkpoint, do not
restart writers, deploy an older application, or restore one store in isolation.
Rerun the identical command to finish an interrupted external cleanup. If the
activated result cannot be accepted, stop all processes and restore PostgreSQL,
Kubernetes, OpenBao, and S3 together from the recorded pre-cutover backups.
Partial restoration can combine source and target identities and is unsupported.
