CREATE TYPE "public"."theme_preference" AS ENUM('system', 'light', 'dark');--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "theme" "theme_preference" DEFAULT 'system' NOT NULL;