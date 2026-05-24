-- ============================================================
-- 002_create_auth_users.sql
-- Authentication only table
-- Isolated from business/profile data
-- ============================================================

CREATE TABLE auth_users (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    email               TEXT            NOT NULL UNIQUE,
    password_hash       TEXT            NULL,               -- NULL for OAuth users
    auth_provider       auth_provider_enum NOT NULL,
    provider_user_id    TEXT            NULL,               -- OAuth provider ID
    email_verified      BOOLEAN         NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMP       NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP       NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CONSTRAINTS / LOGIC
-- ============================================================

-- Local signup: password required
-- OAuth signup: provider_user_id required
ALTER TABLE auth_users
    ADD CONSTRAINT chk_local_requires_password
    CHECK (
        (auth_provider = 'local' AND password_hash IS NOT NULL)
        OR
        (auth_provider != 'local')
    );

ALTER TABLE auth_users
    ADD CONSTRAINT chk_oauth_requires_provider_id
    CHECK (
        (auth_provider != 'local' AND provider_user_id IS NOT NULL)
        OR
        (auth_provider = 'local')
    );

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_auth_users_email
    ON auth_users(email);

CREATE INDEX idx_auth_users_provider
    ON auth_users(auth_provider, provider_user_id);

-- ============================================================
-- AUTO UPDATE updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_auth_users_updated_at
    BEFORE UPDATE ON auth_users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();