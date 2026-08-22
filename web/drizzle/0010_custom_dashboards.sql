ALTER TYPE "public"."event_trail_target" ADD VALUE 'dashboard';--> statement-breakpoint
ALTER TYPE "public"."permission_resource" ADD VALUE 'dashboard';--> statement-breakpoint
CREATE TABLE "dashboard_rate_limits" (
	"key" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "dashboard_rate_limits_key_window_started_at_pk" PRIMARY KEY("key","window_started_at"),
	CONSTRAINT "dashboard_rate_limits_count_ck" CHECK ("dashboard_rate_limits"."count" > 0)
);
--> statement-breakpoint
CREATE TABLE "dashboard_records" (
	"id" text NOT NULL,
	"dashboard_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"record_key" text,
	"session_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"dimensions" jsonb NOT NULL,
	"measures" jsonb NOT NULL,
	CONSTRAINT "dashboard_records_dashboard_id_id_pk" PRIMARY KEY("dashboard_id","id"),
	CONSTRAINT "dashboard_records_record_key_ck" CHECK ("dashboard_records"."record_key" IS NULL OR NULLIF(BTRIM("dashboard_records"."record_key"), '') IS NOT NULL),
	CONSTRAINT "dashboard_records_dimensions_ck" CHECK (jsonb_typeof("dashboard_records"."dimensions") = 'object'),
	CONSTRAINT "dashboard_records_measures_ck" CHECK (jsonb_typeof("dashboard_records"."measures") = 'object'),
	CONSTRAINT "dashboard_records_expiry_ck" CHECK ("dashboard_records"."expires_at" > "dashboard_records"."ingested_at")
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"name" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboards_id_workspace_uidx" UNIQUE("id","workspace_id"),
	CONSTRAINT "dashboards_name_ck" CHECK (NULLIF(BTRIM("dashboards"."name"), '') IS NOT NULL),
	CONSTRAINT "dashboards_revision_ck" CHECK ("dashboards"."revision" >= 1),
	CONSTRAINT "dashboards_definition_ck" CHECK (jsonb_typeof("dashboards"."definition") = 'object')
);
--> statement-breakpoint
ALTER TABLE "dashboard_records" ADD CONSTRAINT "dashboard_records_dashboard_workspace_fk" FOREIGN KEY ("dashboard_id","workspace_id") REFERENCES "public"."dashboards"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_agent_owner_fk" FOREIGN KEY ("workspace_id","agent_name","organization_id") REFERENCES "public"."agent_owners"("workspace_id","agent_name","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_rate_limits_window_idx" ON "dashboard_rate_limits" USING btree ("window_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_records_key_uidx" ON "dashboard_records" USING btree ("dashboard_id","record_key") WHERE "dashboard_records"."record_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "dashboard_records_query_idx" ON "dashboard_records" USING btree ("workspace_id","dashboard_id","observed_at");--> statement-breakpoint
CREATE INDEX "dashboard_records_expiry_idx" ON "dashboard_records" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboards_workspace_agent_name_uidx" ON "dashboards" USING btree ("workspace_id","agent_name","name");--> statement-breakpoint
CREATE INDEX "dashboards_workspace_updated_idx" ON "dashboards" USING btree ("workspace_id","updated_at","id");