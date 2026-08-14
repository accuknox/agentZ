CREATE TABLE "organization_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"inviter_id" text NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "invitation_roles" DROP CONSTRAINT "invitation_roles_invitation_id_invitations_id_fk";
--> statement-breakpoint
ALTER TABLE "invitation_teams" DROP CONSTRAINT "invitation_teams_invitation_id_invitations_id_fk";
--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organizationInvitations_organizationId_idx" ON "organization_invitations" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "invitation_roles" ADD CONSTRAINT "invitation_roles_invitation_id_organization_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."organization_invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_teams" ADD CONSTRAINT "invitation_teams_invitation_id_organization_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."organization_invitations"("id") ON DELETE cascade ON UPDATE no action;