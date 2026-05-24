-- ============================================================
-- 003_create_profiles.sql
-- Business/user profile data
-- Credits, identity, usage tracking
-- ============================================================

CREATE TABLE profiles (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id        UUID            NOT NULL REFERENCES auth_users(id)
                                            ON DELETE CASCADE,
    username            TEXT            NOT NULL UNIQUE,
    user_type           user_type_enum  NOT NULL,
    company_name        TEXT            NULL,               -- Only for company type
    credits             INTEGER         NOT NULL DEFAULT 50, -- Free signup credits
    reserved_credits    INTEGER         NOT NULL DEFAULT 0,  -- Locked during processing
    total_credits_used  INTEGER         NOT NULL DEFAULT 0,  -- Analytics
    is_blocked          BOOLEAN         NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMP       NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP       NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CONSTRAINTS / LOGIC
-- ============================================================

-- Company must have company_name
ALTER TABLE profiles
    ADD CONSTRAINT chk_company_requires_name
    CHECK (
        (user_type = 'company' AND company_name IS NOT NULL)
        OR
        (user_type = 'individual')
    );

-- Individual must NOT have company_name
ALTER TABLE profiles
    ADD CONSTRAINT chk_individual_no_company_name
    CHECK (
        (user_type = 'individual' AND company_name IS NULL)
        OR
        (user_type = 'company')
    );

-- Credits cannot go negative
ALTER TABLE profiles
    ADD CONSTRAINT chk_credits_non_negative
    CHECK (credits >= 0);

-- Reserved credits cannot exceed total credits
ALTER TABLE profiles
    ADD CONSTRAINT chk_reserved_not_exceed_credits
    CHECK (reserved_credits >= 0 AND reserved_credits <= credits);

-- Total credits used non negative
ALTER TABLE profiles
    ADD CONSTRAINT chk_total_credits_used_non_negative
    CHECK (total_credits_used >= 0);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_profiles_auth_user_id
    ON profiles(auth_user_id);

CREATE INDEX idx_profiles_username
    ON profiles(username);

CREATE INDEX idx_profiles_user_type
    ON profiles(user_type);

-- ============================================================
-- AUTO UPDATE updated_at
-- ============================================================

CREATE TRIGGER trg_profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- NOTES
-- ============================================================

-- available_credits = credits - reserved_credits
-- This is computed at query/application level
-- NOT stored as a column (always accurate this way)

-- Job blocking condition (handled in backend):
-- IF (credits - reserved_credits) < job_cost THEN block job