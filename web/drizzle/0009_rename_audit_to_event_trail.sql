ALTER TYPE "public"."audit_actor" RENAME TO "event_trail_actor";--> statement-breakpoint
ALTER TYPE "public"."audit_interface" RENAME TO "event_trail_interface";--> statement-breakpoint
ALTER TYPE "public"."audit_result" RENAME TO "event_trail_result";--> statement-breakpoint
ALTER TYPE "public"."audit_target" RENAME TO "event_trail_target";--> statement-breakpoint
ALTER TABLE "audit_events" RENAME TO "event_trail_events";--> statement-breakpoint
ALTER TABLE "event_trail_events" RENAME CONSTRAINT "audit_events_pkey" TO "event_trail_events_pkey";--> statement-breakpoint
ALTER TABLE "event_trail_events" RENAME CONSTRAINT "audit_events_id_not_null" TO "event_trail_events_id_not_null";--> statement-breakpoint
ALTER TABLE "event_trail_events" RENAME CONSTRAINT "audit_events_organization_id_not_null" TO "event_trail_events_organization_id_not_null";--> statement-breakpoint
ALTER TABLE "event_trail_events" RENAME CONSTRAINT "audit_events_actor_type_not_null" TO "event_trail_events_actor_type_not_null";--> statement-breakpoint
ALTER TABLE "event_trail_events" RENAME CONSTRAINT "audit_events_target_type_not_null" TO "event_trail_events_target_type_not_null";--> statement-breakpoint
ALTER TABLE "event_trail_events" RENAME CONSTRAINT "audit_events_target_id_not_null" TO "event_trail_events_target_id_not_null";--> statement-breakpoint
ALTER TABLE "event_trail_events" RENAME CONSTRAINT "audit_events_category_not_null" TO "event_trail_events_category_not_null";--> statement-breakpoint
ALTER TABLE "event_trail_events" RENAME CONSTRAINT "audit_events_action_not_null" TO "event_trail_events_action_not_null";--> statement-breakpoint
ALTER TABLE "event_trail_events" RENAME CONSTRAINT "audit_events_result_not_null" TO "event_trail_events_result_not_null";--> statement-breakpoint
ALTER TABLE "event_trail_events" RENAME CONSTRAINT "audit_events_automatic_cascade_not_null" TO "event_trail_events_automatic_cascade_not_null";--> statement-breakpoint
ALTER TABLE "event_trail_events" RENAME CONSTRAINT "audit_events_interface_not_null" TO "event_trail_events_interface_not_null";--> statement-breakpoint
ALTER TABLE "event_trail_events" RENAME CONSTRAINT "audit_events_created_at_not_null" TO "event_trail_events_created_at_not_null";--> statement-breakpoint
ALTER TABLE "event_trail_events" DROP CONSTRAINT "audit_events_actor_ck";--> statement-breakpoint
ALTER TABLE "event_trail_events" DROP CONSTRAINT "audit_events_workspace_target_ck";--> statement-breakpoint
ALTER TABLE "event_trail_events" DROP CONSTRAINT "audit_events_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "event_trail_events" DROP CONSTRAINT "audit_events_cleanup_job_organization_fk";
--> statement-breakpoint
DROP INDEX "audit_events_organization_created_idx";--> statement-breakpoint
DROP INDEX "audit_events_workspace_created_idx";--> statement-breakpoint
DROP INDEX "audit_events_created_idx";--> statement-breakpoint
ALTER TABLE "event_trail_events" ADD CONSTRAINT "event_trail_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_trail_events" ADD CONSTRAINT "event_trail_events_cleanup_job_organization_fk" FOREIGN KEY ("cleanup_job_id","organization_id") REFERENCES "public"."cleanup_jobs"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_trail_events_organization_created_idx" ON "event_trail_events" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "event_trail_events_workspace_created_idx" ON "event_trail_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "event_trail_events_created_idx" ON "event_trail_events" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "event_trail_events" ADD CONSTRAINT "event_trail_events_actor_ck" CHECK (("event_trail_events"."actor_type" = 'system' AND "event_trail_events"."actor_id" IS NULL) OR
        ("event_trail_events"."actor_type" <> 'system' AND "event_trail_events"."actor_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "event_trail_events" ADD CONSTRAINT "event_trail_events_workspace_target_ck" CHECK ("event_trail_events"."target_type" <> 'workspace' OR
        ("event_trail_events"."workspace_id" IS NOT NULL AND "event_trail_events"."target_id" = "event_trail_events"."workspace_id"));
