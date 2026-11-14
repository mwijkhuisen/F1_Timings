-- migrate:up
ALTER TABLE lap DROP COLUMN filled;
-- migrate:down
