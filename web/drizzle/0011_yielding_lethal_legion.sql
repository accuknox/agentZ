ALTER TYPE "public"."audit_target" ADD VALUE 'role' BEFORE 'workspace';--> statement-breakpoint
ALTER TYPE "public"."audit_target" ADD VALUE 'sandbox' BEFORE 'workspace';--> statement-breakpoint
ALTER TABLE "role_scopes" DROP CONSTRAINT "role_scopes_name_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "role_scopes_organization_name_uidx" ON "role_scopes" USING btree ("organization_id",lower(btrim("display_name"))) WHERE "role_scopes"."workspace_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "role_scopes_workspace_name_uidx" ON "role_scopes" USING btree ("organization_id","workspace_id",lower(btrim("display_name"))) WHERE "role_scopes"."workspace_id" IS NOT NULL;