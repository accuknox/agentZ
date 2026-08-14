CREATE FUNCTION prevent_organization_slug_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.slug IS DISTINCT FROM OLD.slug THEN
		RAISE EXCEPTION 'Organisation slugs are immutable';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organizations_slug_immutable
BEFORE UPDATE OF slug ON organizations
FOR EACH ROW
EXECUTE FUNCTION prevent_organization_slug_update();
