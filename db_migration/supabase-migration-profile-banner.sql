-- Adds a banner (background) image to user profiles.
-- Safe to run on an existing database; the greenfield supabase-schema.sql already includes this column.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS banner_url TEXT DEFAULT '';
