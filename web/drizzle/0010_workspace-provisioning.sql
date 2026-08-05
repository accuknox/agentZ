ALTER TABLE "workspaces" ADD COLUMN "provisioning_attempt" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_target_ck" CHECK ("audit_events"."target_type" <> 'workspace' OR
        ("audit_events"."workspace_id" IS NOT NULL AND "audit_events"."target_id" = "audit_events"."workspace_id"));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_provisioning_attempt_ck" CHECK ("workspaces"."provisioning_attempt" >= 1);--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_state_failure_reason_ck" CHECK (("workspaces"."state" = 'failed' AND NULLIF(BTRIM("workspaces"."failure_reason"), '') IS NOT NULL) OR
        ("workspaces"."state" <> 'failed' AND "workspaces"."failure_reason" IS NULL));