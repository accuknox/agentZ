CREATE TYPE "public"."audit_interface" AS ENUM('web', 'gateway', 'better_auth', 'controller', 'system');--> statement-breakpoint
CREATE TYPE "public"."audit_target" AS ENUM('organization', 'organization_membership', 'workspace');--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_workspace_organization_fk";
--> statement-breakpoint
DROP INDEX "audit_events_organization_created_idx";--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "target_type" SET DATA TYPE "public"."audit_target" USING "target_type"::"public"."audit_target";--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "category" text NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "interface" "audit_interface" NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_events_organization_created_idx" ON "audit_events" USING btree ("organization_id","created_at","id");