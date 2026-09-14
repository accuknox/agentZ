-- +goose Up
ALTER TYPE chat_session_group_by ADD VALUE 'project';

-- +goose Down
UPDATE workspace_chat_preferences SET group_by = 'none'
WHERE group_by = 'project';

ALTER TABLE workspace_chat_preferences ALTER COLUMN group_by DROP DEFAULT;
ALTER TABLE workspace_chat_preferences ALTER COLUMN group_by TYPE text;
DROP TYPE chat_session_group_by;
CREATE TYPE chat_session_group_by AS ENUM('none', 'agent', 'status', 'date');
ALTER TABLE workspace_chat_preferences
ALTER COLUMN group_by TYPE chat_session_group_by USING group_by::chat_session_group_by;
ALTER TABLE workspace_chat_preferences ALTER COLUMN group_by SET DEFAULT 'none';
