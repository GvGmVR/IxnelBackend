-- ============================================================
-- 006_create_api_keys.sql
-- Hashed developer API keys table for third-party integrations
-- ============================================================

CREATE TABLE api_keys (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id          UUID            NOT NULL REFERENCES profiles(id)
                                            ON DELETE CASCADE,
    key_name            TEXT            NOT NULL,
    key_hash            TEXT            NOT NULL UNIQUE, -- SHA-256 hash of raw key
    key_prefix          TEXT            NOT NULL,        -- Masked view: ixnel_sk_abcd...wXyZ
    last_used_at        TIMESTAMP       NULL,
    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMP       NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP       NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES FOR INSTANT MIDDLEWARE LOOKUP
-- ============================================================

CREATE INDEX idx_api_keys_hash 
    ON api_keys(key_hash); -- Maximizes speed of API key authentication checks

CREATE INDEX idx_api_keys_profile_id 
    ON api_keys(profile_id);

-- ============================================================
-- AUTO UPDATE updated_at
-- ============================================================

CREATE TRIGGER trg_api_keys_updated_at
    BEFORE UPDATE ON api_keys
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();