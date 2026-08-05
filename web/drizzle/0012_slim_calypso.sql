ALTER TYPE "public"."audit_target" ADD VALUE 'team' BEFORE 'role';--> statement-breakpoint
ALTER TYPE "public"."audit_target" ADD VALUE 'mcp_connection' BEFORE 'role';--> statement-breakpoint
ALTER TYPE "public"."audit_target" ADD VALUE 'skill' BEFORE 'workspace';