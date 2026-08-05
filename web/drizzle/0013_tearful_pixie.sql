ALTER TYPE "public"."audit_target" ADD VALUE 'inference_provider' BEFORE 'role';--> statement-breakpoint
ALTER TYPE "public"."audit_target" ADD VALUE 'inference_pool' BEFORE 'role';