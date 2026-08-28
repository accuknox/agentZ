CREATE TYPE "public"."chat_session_group_by" AS ENUM('none', 'agent', 'status', 'date');--> statement-breakpoint
DROP INDEX "chat_sessions_inbox_idx";--> statement-breakpoint
ALTER TABLE "workspace_chat_preferences" ADD COLUMN "group_by" "chat_session_group_by" DEFAULT 'none' NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_sessions_agent_inbox_idx" ON "chat_sessions" USING btree ("workspace_id","agent_name","source_updated_at" DESC NULLS LAST,"session_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_status_inbox_idx" ON "chat_sessions" USING btree ("workspace_id","status","source_updated_at" DESC NULLS LAST,"agent_name","session_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_title_trgm_idx" ON "chat_sessions" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "chat_sessions_inbox_idx" ON "chat_sessions" USING btree ("workspace_id","source_updated_at" DESC NULLS LAST,"agent_name","session_id");