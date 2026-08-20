CREATE TYPE "public"."chat_session_kind" AS ENUM('chat', 'workflow_run');--> statement-breakpoint
CREATE TYPE "public"."chat_session_status" AS ENUM('idle', 'busy', 'retry');--> statement-breakpoint
CREATE TABLE "chat_session_participants" (
	"workspace_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"first_messaged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_messaged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_session_participants_workspace_id_agent_name_session_id_user_id_pk" PRIMARY KEY("workspace_id","agent_name","session_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"workspace_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"session_id" text NOT NULL,
	"parent_session_id" text,
	"title" text NOT NULL,
	"kind" "chat_session_kind" DEFAULT 'chat' NOT NULL,
	"status" "chat_session_status" DEFAULT 'idle' NOT NULL,
	"source_created_at" timestamp with time zone NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_sessions_workspace_id_agent_name_session_id_pk" PRIMARY KEY("workspace_id","agent_name","session_id"),
	CONSTRAINT "chat_sessions_agent_name_ck" CHECK (NULLIF(BTRIM("chat_sessions"."agent_name"), '') IS NOT NULL),
	CONSTRAINT "chat_sessions_session_id_ck" CHECK (NULLIF(BTRIM("chat_sessions"."session_id"), '') IS NOT NULL),
	CONSTRAINT "chat_sessions_title_ck" CHECK (NULLIF(BTRIM("chat_sessions"."title"), '') IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "workspace_chat_preferences" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_name" text,
	"participant_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"include_workflow_runs" boolean DEFAULT false NOT NULL,
	"last_agent_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_chat_preferences_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_chat_preferences_agent_name_ck" CHECK ("workspace_chat_preferences"."agent_name" IS NULL OR NULLIF(BTRIM("workspace_chat_preferences"."agent_name"), '') IS NOT NULL),
	CONSTRAINT "workspace_chat_preferences_last_agent_name_ck" CHECK ("workspace_chat_preferences"."last_agent_name" IS NULL OR NULLIF(BTRIM("workspace_chat_preferences"."last_agent_name"), '') IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "chat_session_participants" ADD CONSTRAINT "chat_session_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_session_participants" ADD CONSTRAINT "chat_session_participants_session_fk" FOREIGN KEY ("workspace_id","agent_name","session_id") REFERENCES "public"."chat_sessions"("workspace_id","agent_name","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_chat_preferences" ADD CONSTRAINT "workspace_chat_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_chat_preferences" ADD CONSTRAINT "workspace_chat_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_session_participants_user_idx" ON "chat_session_participants" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_inbox_idx" ON "chat_sessions" USING btree ("workspace_id","source_updated_at","agent_name","session_id");