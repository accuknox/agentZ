CREATE TYPE "public"."workspace_type" AS ENUM('general', 'coding');--> statement-breakpoint
CREATE TABLE "coding_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"repository_id" bigint NOT NULL,
	"repository" text NOT NULL,
	"default_branch" text NOT NULL,
	"deleting" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coding_projects_workspace_id_uidx" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "coding_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"worktree_id" text NOT NULL,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coding_threads_session_uidx" UNIQUE("workspace_id","agent_name","session_id")
);
--> statement-breakpoint
CREATE TABLE "coding_worktrees" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"directory" text NOT NULL,
	"branch" text NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coding_worktrees_workspace_agent_id_uidx" UNIQUE("workspace_id","agent_name","id"),
	CONSTRAINT "coding_worktrees_directory_uidx" UNIQUE("workspace_id","agent_name","directory")
);
--> statement-breakpoint
CREATE TABLE "github_authorizations" (
	"state" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_connections" (
	"user_id" text PRIMARY KEY NOT NULL,
	"github_user_id" bigint NOT NULL,
	"login" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "type" "workspace_type" DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "coding_projects" ADD CONSTRAINT "coding_projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_projects" ADD CONSTRAINT "coding_projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_threads" ADD CONSTRAINT "coding_threads_workspace_id_agent_name_worktree_id_coding_worktrees_workspace_id_agent_name_id_fk" FOREIGN KEY ("workspace_id","agent_name","worktree_id") REFERENCES "public"."coding_worktrees"("workspace_id","agent_name","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_worktrees" ADD CONSTRAINT "coding_worktrees_workspace_id_project_id_coding_projects_workspace_id_id_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."coding_projects"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_authorizations" ADD CONSTRAINT "github_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_authorizations" ADD CONSTRAINT "github_authorizations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coding_projects_owner_idx" ON "coding_projects" USING btree ("workspace_id","owner_id");