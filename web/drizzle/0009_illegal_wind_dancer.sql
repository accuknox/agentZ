CREATE VIEW "public"."member_role_assignments" AS (
  SELECT
    members.id AS member_id,
    members.user_id,
    member_roles.organization_id,
    member_roles.role_id,
    NULL::text AS team_id
  FROM member_roles
  JOIN members
    ON members.id = member_roles.member_id
    AND members.organization_id = member_roles.organization_id

  UNION ALL

  SELECT
    members.id AS member_id,
    members.user_id,
    team_roles.organization_id,
    team_roles.role_id,
    teams.id AS team_id
  FROM team_roles
  JOIN teams
    ON teams.id = team_roles.team_id
    AND teams.organization_id = team_roles.organization_id
  JOIN team_members
    ON team_members.team_id = teams.id
  JOIN members
    ON members.user_id = team_members.user_id
    AND members.organization_id = teams.organization_id
);