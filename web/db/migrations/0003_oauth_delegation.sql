ALTER TYPE "public"."permission_action" ADD VALUE 'use' BEFORE 'author';--> statement-breakpoint
ALTER TYPE "public"."permission_action" ADD VALUE 'delegate' BEFORE 'author';--> statement-breakpoint
CREATE TABLE "delegation_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text,
	"scopes" text[] NOT NULL,
	"resources" text[] NOT NULL,
	"selection" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "delegation_mcp_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegation_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"authorization_query" text NOT NULL,
	"grant_id" text,
	"scopes" text[] NOT NULL,
	"resources" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_origins" (
	"client_id" text NOT NULL,
	"origin" text NOT NULL,
	CONSTRAINT "oauth_client_origins_client_id_origin_pk" PRIMARY KEY("client_id","origin")
);
--> statement-breakpoint
CREATE TABLE "organization_delegation" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"revoked" timestamp,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_access_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[] DEFAULT '{}',
	"user_id" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean DEFAULT false,
	"reference_id" text,
	"metadata" jsonb,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"revoked" timestamp,
	"rotated_at" timestamp,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp,
	"auth_time" timestamp,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_refresh_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp,
	"updated_at" timestamp,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "oauth_resources_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
ALTER TABLE "permission_grants" DROP CONSTRAINT "permission_grants_resource_action_ck";--> statement-breakpoint
DROP INDEX "organizations_slug_uidx";--> statement-breakpoint
ALTER TABLE "organization_invitations" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "jwks" ADD COLUMN "alg" text;--> statement-breakpoint
ALTER TABLE "jwks" ADD COLUMN "crv" text;--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN "membership_key" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "member_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD CONSTRAINT "delegation_grants_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD CONSTRAINT "delegation_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD CONSTRAINT "delegation_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_mcp_sessions" ADD CONSTRAINT "delegation_mcp_sessions_grant_id_delegation_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."delegation_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_transactions" ADD CONSTRAINT "delegation_transactions_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_transactions" ADD CONSTRAINT "delegation_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_transactions" ADD CONSTRAINT "delegation_transactions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_transactions" ADD CONSTRAINT "delegation_transactions_grant_id_delegation_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."delegation_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_origins" ADD CONSTRAINT "oauth_client_origins_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_delegation" ADD CONSTRAINT "organization_delegation_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_refresh_id_oauth_refresh_tokens_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "public"."oauth_refresh_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resources" ADD CONSTRAINT "oauth_client_resources_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resources" ADD CONSTRAINT "oauth_client_resources_resource_id_oauth_resources_identifier_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resources"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delegation_grants_user_client_idx" ON "delegation_grants" USING btree ("user_id","client_id");--> statement-breakpoint
CREATE INDEX "delegation_transactions_user_client_idx" ON "delegation_transactions" USING btree ("user_id","client_id");--> statement-breakpoint
CREATE INDEX "oauth_client_origins_origin_index" ON "oauth_client_origins" USING btree ("origin");--> statement-breakpoint
CREATE INDEX "oauthAccessTokens_clientId_idx" ON "oauth_access_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthAccessTokens_sessionId_idx" ON "oauth_access_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauthAccessTokens_userId_idx" ON "oauth_access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauthAccessTokens_authorizationCodeId_idx" ON "oauth_access_tokens" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "oauthAccessTokens_refreshId_idx" ON "oauth_access_tokens" USING btree ("refresh_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauthClientResources_clientId_resourceId_uidx" ON "oauth_client_resources" USING btree ("client_id","resource_id");--> statement-breakpoint
CREATE INDEX "oauthClientResources_clientId_idx" ON "oauth_client_resources" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthClientResources_resourceId_idx" ON "oauth_client_resources" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "oauthClients_userId_idx" ON "oauth_clients" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauthConsents_clientId_idx" ON "oauth_consents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthConsents_userId_idx" ON "oauth_consents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshTokens_clientId_idx" ON "oauth_refresh_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshTokens_sessionId_idx" ON "oauth_refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshTokens_userId_idx" ON "oauth_refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshTokens_authorizationCodeId_idx" ON "oauth_refresh_tokens" USING btree ("authorization_code_id");--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_membership_key_unique" UNIQUE("membership_key");--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_resource_action_ck" CHECK (("permission_grants"."resource" = 'agent' AND "permission_grants"."action" IN (
          'author', 'share_authored', 'share_non_authored', 'use_shared',
          'read_shared_secret', 'write_shared_secret', 'delete_shared_secret'
        )) OR ("permission_grants"."resource" IN ('mcp_connection', 'inference_provider') AND "permission_grants"."action"::text IN ('use', 'delegate'))
        OR ("permission_grants"."resource" <> 'agent' AND "permission_grants"."action" IN (
          'read', 'create', 'modify', 'delete'
        )));
--> statement-breakpoint
-- Better Auth 1.7 uses a SHA-256 key of the JSON [team ID, user ID] pair.
-- PostgreSQL's compact JSON construction must match JSON.stringify exactly.
UPDATE team_members
SET membership_key = translate(rtrim(encode(sha256(convert_to(
  '[' || to_json(team_id)::text || ',' || to_json(user_id)::text || ']', 'UTF8'
)), 'base64'), '='), '+/', '-_')
WHERE membership_key IS NULL;
--> statement-breakpoint
UPDATE teams
SET member_count = (SELECT count(*) FROM team_members WHERE team_members.team_id = teams.id);
