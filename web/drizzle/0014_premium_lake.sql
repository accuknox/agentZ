CREATE TABLE "workspace_inherited_resources" (
	"workspace_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"resource" "permission_resource" NOT NULL,
	"resource_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_inherited_resources_workspace_id_resource_resource_name_pk" PRIMARY KEY("workspace_id","resource","resource_name"),
	CONSTRAINT "workspace_inherited_resources_resource_ck" CHECK ("workspace_inherited_resources"."resource" IN ('skill', 'sandbox', 'mcp_connection', 'inference_provider')),
	CONSTRAINT "workspace_inherited_resources_name_ck" CHECK (NULLIF(BTRIM("workspace_inherited_resources"."resource_name"), '') IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "workspace_inherited_resources" ADD CONSTRAINT "workspace_inherited_resources_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_inherited_resources_organization_resource_idx" ON "workspace_inherited_resources" USING btree ("organization_id","resource","resource_name");