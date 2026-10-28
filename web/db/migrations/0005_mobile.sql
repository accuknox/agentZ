CREATE TABLE "mobile_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"device_hash" text,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pairing_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mobile_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"agent_uid" text NOT NULL,
	"session_id" text NOT NULL,
	CONSTRAINT "mobile_conversations_user_id_workspace_id_agent_uid_unique" UNIQUE("user_id","workspace_id","agent_uid")
);
--> statement-breakpoint
ALTER TABLE "mobile_connections" ADD CONSTRAINT "mobile_connections_conversation_id_mobile_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."mobile_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_conversations" ADD CONSTRAINT "mobile_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_conversations" ADD CONSTRAINT "mobile_conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_conversations" ADD CONSTRAINT "mobile_conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;