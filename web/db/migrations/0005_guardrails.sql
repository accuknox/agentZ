ALTER TYPE "public"."event_trail_target" ADD VALUE 'guardrail_connection';--> statement-breakpoint
ALTER TYPE "public"."event_trail_target" ADD VALUE 'guardrail_policy';--> statement-breakpoint
ALTER TYPE "public"."event_trail_target" ADD VALUE 'guardrail_settings';--> statement-breakpoint
ALTER TYPE "public"."event_trail_target" ADD VALUE 'external_access_guardrails';--> statement-breakpoint
ALTER TYPE "public"."permission_resource" ADD VALUE 'guardrail_connection';--> statement-breakpoint
ALTER TYPE "public"."permission_resource" ADD VALUE 'guardrail_policy';--> statement-breakpoint
ALTER TYPE "public"."permission_resource" ADD VALUE 'guardrail_event';--> statement-breakpoint
CREATE TABLE "guardrail_client_access" (
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"client_id" text NOT NULL,
	"policies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "guardrail_client_access_organization_id_workspace_id_client_id_pk" PRIMARY KEY("organization_id","workspace_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_inherited_resources" DROP CONSTRAINT "workspace_inherited_resources_resource_ck";--> statement-breakpoint
ALTER TABLE "guardrail_client_access" ADD CONSTRAINT "guardrail_client_access_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_client_access" ADD CONSTRAINT "guardrail_client_access_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_client_access" ADD CONSTRAINT "guardrail_client_access_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_client_access" ADD CONSTRAINT "guardrail_client_access_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_inherited_resources" ADD CONSTRAINT "workspace_inherited_resources_resource_ck" CHECK ("workspace_inherited_resources"."resource"::text IN ('skill', 'sandbox', 'mcp_connection', 'inference_provider', 'guardrail_connection', 'guardrail_policy'));