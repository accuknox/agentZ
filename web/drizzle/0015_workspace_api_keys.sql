CREATE TYPE "public"."api_key_target_type" AS ENUM('agent', 'workflow');--> statement-breakpoint
ALTER TYPE "public"."audit_target" ADD VALUE 'agent' BEFORE 'workspace';--> statement-breakpoint
ALTER TYPE "public"."audit_target" ADD VALUE 'api_key' BEFORE 'workspace';--> statement-breakpoint
CREATE TABLE "api_key_targets" (
	"api_key_id" text NOT NULL,
	"target_type" "api_key_target_type" NOT NULL,
	"agent_name" text NOT NULL,
	"workflow_name" text DEFAULT '' NOT NULL,
	CONSTRAINT "api_key_targets_api_key_id_agent_name_workflow_name_pk" PRIMARY KEY("api_key_id","agent_name","workflow_name"),
	CONSTRAINT "api_key_targets_type_ck" CHECK (("api_key_targets"."target_type" = 'agent' AND "api_key_targets"."workflow_name" = '') OR
        ("api_key_targets"."target_type" = 'workflow' AND "api_key_targets"."workflow_name" <> ''))
);
--> statement-breakpoint
ALTER TABLE "api_key_scopes" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_key_scopes" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "api_key_targets" ADD CONSTRAINT "api_key_targets_api_key_id_api_key_scopes_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key_scopes"("api_key_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_targets_agent_idx" ON "api_key_targets" USING btree ("agent_name");--> statement-breakpoint
CREATE INDEX "api_key_scopes_revoked_idx" ON "api_key_scopes" USING btree ("organization_id","workspace_id","revoked_at");--> statement-breakpoint
ALTER TABLE "api_key_scopes" ADD CONSTRAINT "api_key_scopes_revocation_reason_ck" CHECK (("api_key_scopes"."revoked_at" IS NULL AND "api_key_scopes"."revoked_reason" IS NULL) OR
        ("api_key_scopes"."revoked_at" IS NOT NULL AND NULLIF(BTRIM("api_key_scopes"."revoked_reason"), '') IS NOT NULL));