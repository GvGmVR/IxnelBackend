-- ============================================================
-- 008_create_projects_workspace.sql
-- 2D Animator Workspace, Assets, and Job Linking
-- PostgreSQL
-- ============================================================

BEGIN;

-- ============================================================
-- ENUMS
-- ============================================================

-- Safely create asset_type_enum if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'asset_type_enum') THEN
        CREATE TYPE asset_type_enum AS ENUM ('reference', 'line_art', 'colorized_render');
    END IF;
END $$;

-- ============================================================
-- PROJECTS TABLE
-- Represents a single animation scene/workspace for a user
-- ============================================================

CREATE TABLE IF NOT EXISTS projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    settings        JSONB NOT NULL DEFAULT '{}'::jsonb, -- e.g., { "fps": 24, "resolution": "1080p" }
    thumbnail_url   TEXT NULL,                          -- Preview image for the dashboard
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Index for fast dashboard loading
CREATE INDEX IF NOT EXISTS idx_projects_profile_id ON projects(profile_id);


-- ============================================================
-- PROJECT ASSETS TABLE
-- Stores metadata for heavy images kept in S3/Cloud storage
-- ============================================================

CREATE TABLE IF NOT EXISTS project_assets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    asset_type      asset_type_enum NOT NULL,
    storage_key     TEXT NOT NULL,                      -- The exact cloud bucket path (e.g. user_id/proj_id/ref.png)
    file_url        TEXT NOT NULL,                      -- Public or presigned URL for the frontend canvas
    frame_number    INTEGER NULL,                       -- E.g., Frame 1, 2, 3 (NULL if it's a general reference sheet)
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Asset constraints
ALTER TABLE project_assets DROP CONSTRAINT IF EXISTS chk_frame_number_positive;
ALTER TABLE project_assets ADD CONSTRAINT chk_frame_number_positive CHECK (frame_number IS NULL OR frame_number >= 0);

-- Asset Indexes for fast workspace rendering
CREATE INDEX IF NOT EXISTS idx_project_assets_project_id ON project_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_project_assets_type ON project_assets(project_id, asset_type);


-- ============================================================
-- MODIFY EXISTING JOBS TABLE
-- Link AI rendering jobs to specific projects
-- ============================================================

-- Add project_id column to jobs if it doesn't exist
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS project_id UUID NULL REFERENCES projects(id) ON DELETE CASCADE;

-- Add index to quickly find all jobs for a specific project
CREATE INDEX IF NOT EXISTS idx_jobs_project_id ON jobs(project_id);

COMMIT;