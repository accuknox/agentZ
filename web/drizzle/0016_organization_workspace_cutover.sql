ALTER TYPE "public"."audit_target" ADD VALUE 'workspace_access' BEFORE 'workspace';--> statement-breakpoint
ALTER TYPE "public"."cleanup_state" ADD VALUE 'retrying';--> statement-breakpoint
CREATE TABLE "tenant_cutovers" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"source_namespace" text NOT NULL,
	"workspace_id" text NOT NULL,
	"target_namespace" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"inventory_hash" text NOT NULL,
	"backup_manifest_hash" text NOT NULL,
	"checkpoint" text DEFAULT 'planned' NOT NULL,
	"inventory" jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_cutovers_workspace_id_unique" UNIQUE("workspace_id"),
	CONSTRAINT "tenant_cutovers_target_namespace_unique" UNIQUE("target_namespace"),
	CONSTRAINT "tenant_cutovers_checkpoint_ck" CHECK ("tenant_cutovers"."checkpoint" IN (
        'planned', 'sql', 'kubernetes', 'openbao', 's3', 'verified', 'activated'
      )),
	CONSTRAINT "tenant_cutovers_activation_ck" CHECK (("tenant_cutovers"."verified_at" IS NOT NULL) = ("tenant_cutovers"."checkpoint" IN ('verified', 'sql', 'activated')) AND
        ("tenant_cutovers"."activated_at" IS NOT NULL) = ("tenant_cutovers"."checkpoint" = 'activated'))
);
--> statement-breakpoint
ALTER TABLE "tenant_cutovers" ADD CONSTRAINT "tenant_cutovers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_cutovers" ADD CONSTRAINT "tenant_cutovers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;