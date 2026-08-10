ALTER TABLE "cleanup_jobs" ALTER COLUMN "state" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "cleanup_jobs" ALTER COLUMN "state" SET DEFAULT 'pending'::text;--> statement-breakpoint
DROP TYPE "public"."cleanup_state";--> statement-breakpoint
CREATE TYPE "public"."cleanup_state" AS ENUM('pending', 'running', 'retrying', 'failed', 'succeeded');--> statement-breakpoint
ALTER TABLE "cleanup_jobs" ALTER COLUMN "state" SET DEFAULT 'pending'::"public"."cleanup_state";--> statement-breakpoint
ALTER TABLE "cleanup_jobs" ALTER COLUMN "state" SET DATA TYPE "public"."cleanup_state" USING "state"::"public"."cleanup_state";