DROP INDEX "members_organizationId_idx";--> statement-breakpoint
DROP INDEX "members_userId_idx";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_organization_id_organizations_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "members_organizationId_uidx" ON "members" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "members_userId_uidx" ON "members" USING btree ("user_id");