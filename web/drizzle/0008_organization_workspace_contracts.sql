CREATE TYPE "public"."agent_share_capability" AS ENUM('share_non_authored', 'use_shared', 'read_shared_secret', 'write_shared_secret', 'delete_shared_secret');--> statement-breakpoint
CREATE TYPE "public"."audit_actor" AS ENUM('user', 'api_key', 'system');--> statement-breakpoint
CREATE TYPE "public"."audit_result" AS ENUM('succeeded', 'denied', 'failed');--> statement-breakpoint
CREATE TYPE "public"."cleanup_state" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."destructive_operation" AS ENUM('membership_disable', 'membership_remove', 'team_delete', 'role_reduce', 'access_revoke', 'workspace_delete');--> statement-breakpoint
CREATE TYPE "public"."destructive_target" AS ENUM('organization_membership', 'team', 'role', 'workspace_access', 'workspace');--> statement-breakpoint
CREATE TYPE "public"."permission_action" AS ENUM('read', 'create', 'modify', 'delete', 'author', 'share_authored', 'share_non_authored', 'use_shared', 'read_shared_secret', 'write_shared_secret', 'delete_shared_secret');--> statement-breakpoint
CREATE TYPE "public"."permission_resource" AS ENUM('mcp_connection', 'skill', 'sandbox', 'inference_provider', 'inference_pool', 'agent', 'api_key', 'observability');--> statement-breakpoint
CREATE TYPE "public"."system_role" AS ENUM('superadmin', 'workspace_admin');--> statement-breakpoint
CREATE TYPE "public"."workspace_state" AS ENUM('provisioning', 'ready', 'failed', 'deleting');--> statement-breakpoint
CREATE TABLE "agent_owners" (
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"creator_user_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_owners_workspace_id_agent_name_pk" PRIMARY KEY("workspace_id","agent_name"),
	CONSTRAINT "agent_owners_workspace_agent_organization_uidx" UNIQUE("workspace_id","agent_name","organization_id")
);
--> statement-breakpoint
CREATE TABLE "agent_share_grants" (
	"share_id" text NOT NULL,
	"capability" "agent_share_capability" NOT NULL,
	CONSTRAINT "agent_share_grants_share_id_capability_pk" PRIMARY KEY("share_id","capability")
);
--> statement-breakpoint
CREATE TABLE "agent_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"target_user_id" text,
	"target_team_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_shares_target_ck" CHECK (num_nonnulls("agent_shares"."target_user_id", "agent_shares"."target_team_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "api_key_scopes" (
	"api_key_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"creator_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"actor_type" "audit_actor" NOT NULL,
	"actor_id" text,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"action" text NOT NULL,
	"result" "audit_result" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"automatic_cascade" boolean DEFAULT false NOT NULL,
	"cleanup_job_id" text,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_actor_ck" CHECK (("audit_events"."actor_type" = 'system' AND "audit_events"."actor_id" IS NULL) OR
        ("audit_events"."actor_type" <> 'system' AND "audit_events"."actor_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "cleanup_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"operation" "destructive_operation" NOT NULL,
	"target_type" "destructive_target" NOT NULL,
	"target_id" text NOT NULL,
	"state" "cleanup_state" DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "cleanup_jobs_id_organization_uidx" UNIQUE("id","organization_id"),
	CONSTRAINT "cleanup_jobs_lease_ck" CHECK (("cleanup_jobs"."state" = 'running') =
        ("cleanup_jobs"."lease_token" IS NOT NULL AND "cleanup_jobs"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "cleanup_jobs_operation_target_ck" CHECK (("cleanup_jobs"."operation" IN ('membership_disable', 'membership_remove') AND
          "cleanup_jobs"."target_type" = 'organization_membership') OR
        ("cleanup_jobs"."operation" = 'team_delete' AND "cleanup_jobs"."target_type" = 'team') OR
        ("cleanup_jobs"."operation" = 'role_reduce' AND "cleanup_jobs"."target_type" = 'role') OR
        ("cleanup_jobs"."operation" = 'access_revoke' AND "cleanup_jobs"."target_type" = 'workspace_access') OR
        ("cleanup_jobs"."operation" = 'workspace_delete' AND "cleanup_jobs"."target_type" = 'workspace'))
);
--> statement-breakpoint
CREATE TABLE "invitation_roles" (
	"invitation_id" text NOT NULL,
	"role_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_roles_invitation_id_role_id_pk" PRIMARY KEY("invitation_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "invitation_teams" (
	"invitation_id" text NOT NULL,
	"team_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_teams_invitation_id_team_id_pk" PRIMARY KEY("invitation_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "last_accessible_contexts" (
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"route" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "last_accessible_contexts_user_id_organization_id_pk" PRIMARY KEY("user_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "member_roles" (
	"member_id" text NOT NULL,
	"role_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_roles_member_id_role_id_pk" PRIMARY KEY("member_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "organization_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"role" text NOT NULL,
	"permission" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "organization_slug_history" (
	"slug" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_grants" (
	"role_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"resource" "permission_resource" NOT NULL,
	"action" "permission_action" NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_grants_scope_uidx" UNIQUE NULLS NOT DISTINCT("role_id","organization_id","workspace_id","resource","action"),
	CONSTRAINT "permission_grants_resource_action_ck" CHECK (("permission_grants"."resource" = 'agent' AND "permission_grants"."action" IN (
          'author', 'share_authored', 'share_non_authored', 'use_shared',
          'read_shared_secret', 'write_shared_secret', 'delete_shared_secret'
        )) OR ("permission_grants"."resource" <> 'agent' AND "permission_grants"."action" IN (
          'read', 'create', 'modify', 'delete'
        )))
);
--> statement-breakpoint
CREATE TABLE "role_scopes" (
	"role_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"display_name" text NOT NULL,
	"system_role" "system_role",
	"immutable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_scopes_role_organization_uidx" UNIQUE("role_id","organization_id"),
	CONSTRAINT "role_scopes_name_uidx" UNIQUE NULLS NOT DISTINCT("organization_id","workspace_id","display_name"),
	CONSTRAINT "role_scopes_system_role_ck" CHECK (("role_scopes"."system_role" IS NULL OR "role_scopes"."immutable") AND
        ("role_scopes"."system_role" IS DISTINCT FROM 'superadmin' OR "role_scopes"."workspace_id" IS NULL) AND
        ("role_scopes"."system_role" IS DISTINCT FROM 'workspace_admin' OR "role_scopes"."workspace_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "social_admission_default_roles" (
	"organization_id" text NOT NULL,
	"role_id" text NOT NULL,
	CONSTRAINT "social_admission_default_roles_organization_id_role_id_pk" PRIMARY KEY("organization_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "social_admission_default_teams" (
	"organization_id" text NOT NULL,
	"team_id" text NOT NULL,
	CONSTRAINT "social_admission_default_teams_organization_id_team_id_pk" PRIMARY KEY("organization_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "social_admission_github_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"github_organization" text NOT NULL,
	"github_team" text,
	CONSTRAINT "social_admission_github_rules_rule_uidx" UNIQUE NULLS NOT DISTINCT("organization_id","github_organization","github_team")
);
--> statement-breakpoint
CREATE TABLE "social_admission_google_domains" (
	"organization_id" text NOT NULL,
	"domain" text NOT NULL,
	CONSTRAINT "social_admission_google_domains_organization_id_domain_pk" PRIMARY KEY("organization_id","domain")
);
--> statement-breakpoint
CREATE TABLE "social_admission_policies" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "team_roles" (
	"team_id" text NOT NULL,
	"role_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_roles_team_id_role_id_pk" PRIMARY KEY("team_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "workspace_slug_history" (
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_slug_history_organization_id_slug_pk" PRIMARY KEY("organization_id","slug")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"namespace" text NOT NULL,
	"state" "workspace_state" DEFAULT 'provisioning' NOT NULL,
	"failure_reason" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_namespace_unique" UNIQUE("namespace"),
	CONSTRAINT "workspaces_id_organization_uidx" UNIQUE("id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "disabled_at" timestamp;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "active_team_id" text;--> statement-breakpoint
ALTER TABLE "two_factors" ADD COLUMN "failed_verification_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "two_factors" ADD COLUMN "locked_until" timestamp;--> statement-breakpoint
ALTER TABLE "agent_owners" ADD CONSTRAINT "agent_owners_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_owners" ADD CONSTRAINT "agent_owners_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_owners" ADD CONSTRAINT "agent_owners_creator_user_id_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_owners" ADD CONSTRAINT "agent_owners_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_owners" ADD CONSTRAINT "agent_owners_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_share_grants" ADD CONSTRAINT "agent_share_grants_share_id_agent_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."agent_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_shares" ADD CONSTRAINT "agent_shares_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_shares" ADD CONSTRAINT "agent_shares_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_shares" ADD CONSTRAINT "agent_shares_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_shares" ADD CONSTRAINT "agent_shares_target_team_id_teams_id_fk" FOREIGN KEY ("target_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_shares" ADD CONSTRAINT "agent_shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_shares" ADD CONSTRAINT "agent_shares_owner_fk" FOREIGN KEY ("workspace_id","agent_name","organization_id") REFERENCES "public"."agent_owners"("workspace_id","agent_name","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_scopes" ADD CONSTRAINT "api_key_scopes_api_key_id_apikeys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."apikeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_scopes" ADD CONSTRAINT "api_key_scopes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_scopes" ADD CONSTRAINT "api_key_scopes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_scopes" ADD CONSTRAINT "api_key_scopes_creator_user_id_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_scopes" ADD CONSTRAINT "api_key_scopes_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_cleanup_job_organization_fk" FOREIGN KEY ("cleanup_job_id","organization_id") REFERENCES "public"."cleanup_jobs"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleanup_jobs" ADD CONSTRAINT "cleanup_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleanup_jobs" ADD CONSTRAINT "cleanup_jobs_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_roles" ADD CONSTRAINT "invitation_roles_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_roles" ADD CONSTRAINT "invitation_roles_role_organization_fk" FOREIGN KEY ("role_id","organization_id") REFERENCES "public"."role_scopes"("role_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_teams" ADD CONSTRAINT "invitation_teams_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_teams" ADD CONSTRAINT "invitation_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_teams" ADD CONSTRAINT "invitation_teams_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "last_accessible_contexts" ADD CONSTRAINT "last_accessible_contexts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "last_accessible_contexts" ADD CONSTRAINT "last_accessible_contexts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "last_accessible_contexts" ADD CONSTRAINT "last_accessible_contexts_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_role_organization_fk" FOREIGN KEY ("role_id","organization_id") REFERENCES "public"."role_scopes"("role_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_roles" ADD CONSTRAINT "organization_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_slug_history" ADD CONSTRAINT "organization_slug_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_role_organization_fk" FOREIGN KEY ("role_id","organization_id") REFERENCES "public"."role_scopes"("role_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_scopes" ADD CONSTRAINT "role_scopes_role_id_organization_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."organization_roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_scopes" ADD CONSTRAINT "role_scopes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_scopes" ADD CONSTRAINT "role_scopes_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_admission_default_roles" ADD CONSTRAINT "social_admission_default_roles_organization_id_social_admission_policies_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."social_admission_policies"("organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_admission_default_roles" ADD CONSTRAINT "social_default_roles_role_organization_fk" FOREIGN KEY ("role_id","organization_id") REFERENCES "public"."role_scopes"("role_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_admission_default_teams" ADD CONSTRAINT "social_admission_default_teams_organization_id_social_admission_policies_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."social_admission_policies"("organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_admission_default_teams" ADD CONSTRAINT "social_admission_default_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_admission_github_rules" ADD CONSTRAINT "social_admission_github_rules_organization_id_social_admission_policies_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."social_admission_policies"("organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_admission_google_domains" ADD CONSTRAINT "social_admission_google_domains_organization_id_social_admission_policies_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."social_admission_policies"("organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_admission_policies" ADD CONSTRAINT "social_admission_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_roles" ADD CONSTRAINT "team_roles_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_roles" ADD CONSTRAINT "team_roles_role_organization_fk" FOREIGN KEY ("role_id","organization_id") REFERENCES "public"."role_scopes"("role_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_slug_history" ADD CONSTRAINT "workspace_slug_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_slug_history" ADD CONSTRAINT "workspace_slug_history_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_slug_history" ADD CONSTRAINT "workspace_slug_history_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_shares_user_uidx" ON "agent_shares" USING btree ("workspace_id","agent_name","target_user_id") WHERE "agent_shares"."target_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_shares_team_uidx" ON "agent_shares" USING btree ("workspace_id","agent_name","target_team_id") WHERE "agent_shares"."target_team_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_shares_workspace_agent_idx" ON "agent_shares" USING btree ("workspace_id","agent_name");--> statement-breakpoint
CREATE INDEX "api_key_scopes_workspace_idx" ON "api_key_scopes" USING btree ("organization_id","workspace_id");--> statement-breakpoint
CREATE INDEX "api_key_scopes_creator_idx" ON "api_key_scopes" USING btree ("organization_id","creator_user_id");--> statement-breakpoint
CREATE INDEX "audit_events_organization_created_idx" ON "audit_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_created_idx" ON "audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "cleanup_jobs_due_idx" ON "cleanup_jobs" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "organizationRoles_organizationId_idx" ON "organization_roles" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "organizationRoles_role_idx" ON "organization_roles" USING btree ("role");--> statement-breakpoint
CREATE INDEX "permission_grants_scope_idx" ON "permission_grants" USING btree ("organization_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_scopes_organization_system_uidx" ON "role_scopes" USING btree ("organization_id","system_role") WHERE "role_scopes"."system_role" IS NOT NULL AND "role_scopes"."workspace_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "role_scopes_workspace_system_uidx" ON "role_scopes" USING btree ("organization_id","workspace_id","system_role") WHERE "role_scopes"."system_role" IS NOT NULL AND "role_scopes"."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "role_scopes_organization_idx" ON "role_scopes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "teamMembers_teamId_idx" ON "team_members" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "teamMembers_userId_idx" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "teams_organizationId_idx" ON "teams" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "workspace_slug_history_workspace_idx" ON "workspace_slug_history" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_organization_slug_uidx" ON "workspaces" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "workspaces_organization_state_idx" ON "workspaces" USING btree ("organization_id","state");