ALTER TABLE "api_key_scopes" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_key_scopes" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
CREATE INDEX "api_key_scopes_revoked_idx" ON "api_key_scopes" USING btree ("organization_id","workspace_id","revoked_at");--> statement-breakpoint
ALTER TABLE "api_key_scopes" ADD CONSTRAINT "api_key_scopes_revocation_reason_ck" CHECK (("api_key_scopes"."revoked_at" IS NULL AND "api_key_scopes"."revoked_reason" IS NULL) OR
        ("api_key_scopes"."revoked_at" IS NOT NULL AND NULLIF(BTRIM("api_key_scopes"."revoked_reason"), '') IS NOT NULL));
