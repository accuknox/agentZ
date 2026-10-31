ALTER TABLE "user_preferences" ADD COLUMN "show_reasoning_and_tools" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- Authority changes reconnect live readers through normal authorization.
-- Text chunks do not perform database permission checks.
CREATE FUNCTION notify_stream_authorization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('agentz_stream_authorization', '');
    RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER members_stream_authorization
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON members
FOR EACH STATEMENT EXECUTE FUNCTION notify_stream_authorization();
--> statement-breakpoint
CREATE TRIGGER member_roles_stream_authorization
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON member_roles
FOR EACH STATEMENT EXECUTE FUNCTION notify_stream_authorization();
--> statement-breakpoint
CREATE TRIGGER team_roles_stream_authorization
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON team_roles
FOR EACH STATEMENT EXECUTE FUNCTION notify_stream_authorization();
--> statement-breakpoint
CREATE TRIGGER team_members_stream_authorization
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON team_members
FOR EACH STATEMENT EXECUTE FUNCTION notify_stream_authorization();
--> statement-breakpoint
CREATE TRIGGER role_scopes_stream_authorization
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON role_scopes
FOR EACH STATEMENT EXECUTE FUNCTION notify_stream_authorization();
--> statement-breakpoint
CREATE TRIGGER permission_grants_stream_authorization
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON permission_grants
FOR EACH STATEMENT EXECUTE FUNCTION notify_stream_authorization();
--> statement-breakpoint
CREATE TRIGGER agent_owners_stream_authorization
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON agent_owners
FOR EACH STATEMENT EXECUTE FUNCTION notify_stream_authorization();
--> statement-breakpoint
CREATE TRIGGER agent_shares_stream_authorization
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON agent_shares
FOR EACH STATEMENT EXECUTE FUNCTION notify_stream_authorization();
--> statement-breakpoint
CREATE TRIGGER agent_share_grants_stream_authorization
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON agent_share_grants
FOR EACH STATEMENT EXECUTE FUNCTION notify_stream_authorization();
--> statement-breakpoint
CREATE TRIGGER workspaces_stream_authorization
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON workspaces
FOR EACH STATEMENT EXECUTE FUNCTION notify_stream_authorization();
--> statement-breakpoint
CREATE TRIGGER api_key_scopes_stream_authorization
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON api_key_scopes
FOR EACH STATEMENT EXECUTE FUNCTION notify_stream_authorization();
--> statement-breakpoint
CREATE TRIGGER api_key_targets_stream_authorization
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON api_key_targets
FOR EACH STATEMENT EXECUTE FUNCTION notify_stream_authorization();
--> statement-breakpoint
CREATE TRIGGER apikeys_stream_authorization
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON apikeys
FOR EACH STATEMENT EXECUTE FUNCTION notify_stream_authorization();
