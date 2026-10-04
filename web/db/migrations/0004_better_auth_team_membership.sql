-- Better Auth 1.7 uses a SHA-256 key of the JSON [team ID, user ID] pair.
-- PostgreSQL's compact JSON construction must match JSON.stringify exactly.
UPDATE team_members
SET membership_key = translate(rtrim(encode(sha256(convert_to(
  '[' || to_json(team_id)::text || ',' || to_json(user_id)::text || ']', 'UTF8'
)), 'base64'), '='), '+/', '-_')
WHERE membership_key IS NULL;
--> statement-breakpoint
UPDATE teams
SET member_count = (SELECT count(*) FROM team_members WHERE team_members.team_id = teams.id);
