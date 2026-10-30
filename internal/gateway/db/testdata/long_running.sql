INSERT INTO users(id, name, email)
VALUES ('lr-a', 'Alice', 'lr-a@example.test'), ('lr-b', 'Bob', 'lr-b@example.test');
INSERT INTO organizations(id, name, slug, created_at)
VALUES ('lr-org', 'Long-running test', 'lr-org', now());
INSERT INTO workspaces(id, organization_id, name, slug, namespace, type)
VALUES ('lr-general', 'lr-org', 'General', 'general', 'lr-general', 'general'),
       ('lr-coding', 'lr-org', 'Coding', 'coding', 'lr-coding', 'coding');
INSERT INTO chat_sessions(workspace_id, agent_name, session_id, title, source_created_at, source_updated_at)
VALUES ('lr-general', 'agent', 'ses_ordinary', 'Shared', now(), now());

-- stage
UPDATE chat_sessions SET next_check_at = now() - interval '1 hour'
WHERE session_id = 'ses_lr_test';

-- stage
UPDATE chat_inputs SET state = 'failed'
WHERE origin = 'proactive' AND completed_at IS NULL;
