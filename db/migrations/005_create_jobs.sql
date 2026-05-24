-- ============================================================
-- 005_create_jobs.sql
-- AI processing job lifecycle table
-- ============================================================

CREATE TABLE jobs (
    id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id          UUID                NOT NULL REFERENCES profiles(id)
                                                ON DELETE CASCADE,
    input_path          TEXT                NOT NULL,           -- uploaded asset location
    output_path         TEXT                NULL,               -- generated result (after completion)
    status              job_status_enum     NOT NULL DEFAULT 'queued',
    job_cost            INTEGER             NOT NULL,           -- credits this job costs
    model_version       TEXT                NOT NULL,           -- for reproducibility
    priority            INTEGER             NOT NULL DEFAULT 0, -- queue ordering
    processing_time_ms  INTEGER             NULL,               -- analytics
    error_message       TEXT                NULL,               -- populated on failure
    created_at          TIMESTAMP           NOT NULL DEFAULT NOW(),
    started_at          TIMESTAMP           NULL,               -- when worker picks it up
    completed_at        TIMESTAMP           NULL,               -- success or failure timestamp
    expires_at          TIMESTAMP           NULL                -- cleanup policy
);

-- ============================================================
-- CONSTRAINTS
-- ============================================================

-- Job cost must be positive
ALTER TABLE jobs
    ADD CONSTRAINT chk_job_cost_positive
    CHECK (job_cost > 0);

-- Priority non negative
ALTER TABLE jobs
    ADD CONSTRAINT chk_priority_non_negative
    CHECK (priority >= 0);

-- completed_at only set when status is terminal
ALTER TABLE jobs
    ADD CONSTRAINT chk_completed_at_terminal_only
    CHECK (
        (completed_at IS NULL)
        OR
        (status IN ('completed', 'failed', 'cancelled'))
    );

-- started_at must exist if status passed queued
ALTER TABLE jobs
    ADD CONSTRAINT chk_started_at_required_if_processing
    CHECK (
        (status IN ('queued', 'blocked'))
        OR
        (started_at IS NOT NULL)
    );

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_jobs_profile_id
    ON jobs(profile_id);

CREATE INDEX idx_jobs_status
    ON jobs(status);

CREATE INDEX idx_jobs_created_at
    ON jobs(created_at);

CREATE INDEX idx_jobs_priority_status
    ON jobs(priority DESC, created_at ASC)
    WHERE status = 'queued';  -- partial index for queue worker efficiency

-- ============================================================
-- JOB FLOW REFERENCE
-- ============================================================

-- queued     → initiated → processing → completed
--                                     → failed
-- queued     → blocked   (insufficient credits)
-- any        → cancelled (user cancels)