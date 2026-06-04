-- ============================================================
-- 009_add_storage_mode.sql
-- Idempotent hybrid storage and tiered limit extensions
-- PostgreSQL
-- ============================================================

BEGIN;

-- Safely create storage_mode_enum if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'storage_mode_enum') THEN
        CREATE TYPE storage_mode_enum AS ENUM ('cloud', 'local');
    END IF;
END $$;

-- 1. Add storage_mode column to projects
ALTER TABLE projects 
    ADD COLUMN IF NOT EXISTS storage_mode storage_mode_enum NOT NULL DEFAULT 'cloud';

-- 2. Add file_size_bytes column to project_assets to track tiered storage limits [1.2.4]
ALTER TABLE project_assets 
    ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT NOT NULL DEFAULT 0;

-- 3. Add constraint checking that file size is non-negative
ALTER TABLE project_assets
    DROP CONSTRAINT IF EXISTS chk_project_assets_file_size_positive;

ALTER TABLE project_assets
    ADD CONSTRAINT chk_project_assets_file_size_positive
    CHECK (file_size_bytes >= 0);

COMMIT;