ALTER TABLE "event_trail_events" DROP CONSTRAINT "event_trail_events_cleanup_job_organization_fk";
--> statement-breakpoint
ALTER TABLE "event_trail_events" DROP COLUMN "automatic_cascade";--> statement-breakpoint
ALTER TABLE "event_trail_events" DROP COLUMN "cleanup_job_id";--> statement-breakpoint
ALTER TABLE "event_trail_events" DROP COLUMN "interface";--> statement-breakpoint
ALTER TABLE "event_trail_events" DROP COLUMN "ip_address";--> statement-breakpoint
ALTER TABLE "event_trail_events" DROP COLUMN "user_agent";--> statement-breakpoint
DROP TYPE "public"."event_trail_interface";