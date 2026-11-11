ALTER TYPE "public"."external_agent_kind" ADD VALUE 'microsoft-copilot-studio';--> statement-breakpoint
CREATE TABLE "copilot_studio_agents" (
	"integration_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"client_id" text,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "copilot_studio_agents_integration_id_agent_id_pk" PRIMARY KEY("integration_id","agent_id"),
	CONSTRAINT "copilot_studio_agents_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "copilot_studio_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"tenant_id" text NOT NULL,
	"application_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"failure_mode" text DEFAULT 'closed' NOT NULL,
	"policies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"runtime_error" text DEFAULT '' NOT NULL,
	CONSTRAINT "copilot_studio_integrations_tenant_id_application_id_environment_id_unique" UNIQUE("tenant_id","application_id","environment_id"),
	CONSTRAINT "copilot_studio_failure_mode" CHECK ("copilot_studio_integrations"."failure_mode" in ('open', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "copilot_studio_agents" ADD CONSTRAINT "copilot_studio_agents_integration_id_copilot_studio_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."copilot_studio_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_studio_agents" ADD CONSTRAINT "copilot_studio_agents_client_id_external_agents_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."external_agents"("client_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_studio_integrations" ADD CONSTRAINT "copilot_studio_integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_studio_integrations" ADD CONSTRAINT "copilot_studio_integrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_studio_integrations" ADD CONSTRAINT "copilot_studio_integrations_workspace_id_organization_id_workspaces_id_organization_id_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "copilot_studio_integrations_workspace_idx" ON "copilot_studio_integrations" USING btree ("organization_id","workspace_id","id");