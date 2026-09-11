ALTER TABLE "coding_worktrees" ADD COLUMN "deleting" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "coding_projects" DROP COLUMN "deleting";