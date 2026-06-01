-- ============================================================
-- 007_billing_system_upgrade.sql
-- Production-ready billing architecture upgrade
-- PostgreSQL (Idempotent Safe version)
-- ============================================================

BEGIN;

-- ============================================================
-- ENUM UPDATES
-- ============================================================

-- ------------------------------------------------------------
-- payment_status_enum additions
-- ------------------------------------------------------------

ALTER TYPE payment_status_enum
    ADD VALUE IF NOT EXISTS 'processing';

ALTER TYPE payment_status_enum
    ADD VALUE IF NOT EXISTS 'cancelled';

ALTER TYPE payment_status_enum
    ADD VALUE IF NOT EXISTS 'chargeback';


-- ============================================================
-- PROFILES TABLE UPGRADE
-- Cached balance for fast reads
-- ============================================================

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS current_credit_balance INTEGER NOT NULL DEFAULT 0;

-- Drop constraint if it already exists before creating to prevent abort [1]
ALTER TABLE profiles
    DROP CONSTRAINT IF EXISTS chk_profiles_credit_balance_non_negative;

ALTER TABLE profiles
    ADD CONSTRAINT chk_profiles_credit_balance_non_negative
    CHECK (current_credit_balance >= 0);


-- ============================================================
-- PAYMENTS TABLE UPGRADE
-- ============================================================

-- ------------------------------------------------------------
-- Currency support
-- ------------------------------------------------------------

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS currency_code CHAR(3)
    NOT NULL DEFAULT 'USD';

-- ------------------------------------------------------------
-- Payment classification
-- ------------------------------------------------------------

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS payment_type TEXT
    NOT NULL DEFAULT 'credit_purchase';

-- ------------------------------------------------------------
-- Provider customer mapping
-- ------------------------------------------------------------

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS provider_customer_id TEXT NULL;

-- ------------------------------------------------------------
-- Flexible provider metadata
-- ------------------------------------------------------------

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS metadata JSONB NULL;

-- ------------------------------------------------------------
-- Provider fee tracking
-- ------------------------------------------------------------

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS provider_fee DECIMAL(10,2) NULL;

-- ------------------------------------------------------------
-- Tax tracking
-- ------------------------------------------------------------

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(10,2) NULL;

-- ------------------------------------------------------------
-- Prevent duplicate provider transactions
-- ------------------------------------------------------------

ALTER TABLE payments
    DROP CONSTRAINT IF EXISTS uq_payments_provider_transaction;

ALTER TABLE payments
    ADD CONSTRAINT uq_payments_provider_transaction
    UNIQUE(payment_provider, provider_transaction_id);

-- ------------------------------------------------------------
-- Currency validation
-- ------------------------------------------------------------

ALTER TABLE payments
    DROP CONSTRAINT IF EXISTS chk_currency_code_length;

ALTER TABLE payments
    ADD CONSTRAINT chk_currency_code_length
    CHECK (char_length(currency_code) = 3);

-- ------------------------------------------------------------
-- Payment type validation
-- ------------------------------------------------------------

ALTER TABLE payments
    DROP CONSTRAINT IF EXISTS chk_payment_type_valid;

ALTER TABLE payments
    ADD CONSTRAINT chk_payment_type_valid
    CHECK (
        payment_type IN (
            'credit_purchase',
            'subscription',
            'addon_purchase',
            'enterprise_invoice'
        )
    );

-- ------------------------------------------------------------
-- Provider fee positive
-- ------------------------------------------------------------

ALTER TABLE payments
    DROP CONSTRAINT IF EXISTS chk_provider_fee_positive;

ALTER TABLE payments
    ADD CONSTRAINT chk_provider_fee_positive
    CHECK (
        provider_fee IS NULL
        OR provider_fee >= 0
    );

-- ------------------------------------------------------------
-- Tax amount positive
-- ------------------------------------------------------------

ALTER TABLE payments
    DROP CONSTRAINT IF EXISTS chk_tax_amount_positive;

ALTER TABLE payments
    ADD CONSTRAINT chk_tax_amount_positive
    CHECK (
        tax_amount IS NULL
        OR tax_amount >= 0
    );


-- ============================================================
-- SUBSCRIPTIONS TABLE
-- Recurring billing state
-- ============================================================

CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    profile_id UUID NOT NULL REFERENCES profiles(id)
        ON DELETE CASCADE,

    payment_provider payment_provider_enum NOT NULL,

    provider_subscription_id TEXT NOT NULL,

    provider_customer_id TEXT NOT NULL,

    plan_code TEXT NOT NULL,

    subscription_status TEXT NOT NULL,

    billing_cycle TEXT NOT NULL,

    current_period_start TIMESTAMP NOT NULL,

    current_period_end TIMESTAMP NOT NULL,

    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMP NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Subscription constraints
-- ------------------------------------------------------------

ALTER TABLE subscriptions
    DROP CONSTRAINT IF EXISTS chk_subscription_status_valid;

ALTER TABLE subscriptions
    ADD CONSTRAINT chk_subscription_status_valid
    CHECK (
        subscription_status IN (
            'active',
            'cancelled',
            'past_due',
            'trialing',
            'expired'
        )
    );

ALTER TABLE subscriptions
    DROP CONSTRAINT IF EXISTS chk_billing_cycle_valid;

ALTER TABLE subscriptions
    ADD CONSTRAINT chk_billing_cycle_valid
    CHECK (
        billing_cycle IN (
            'monthly',
            'yearly'
        )
    );

ALTER TABLE subscriptions
    DROP CONSTRAINT IF EXISTS chk_subscription_period_valid;

ALTER TABLE subscriptions
    ADD CONSTRAINT chk_subscription_period_valid
    CHECK (
        current_period_end > current_period_start
    );

ALTER TABLE subscriptions
    DROP CONSTRAINT IF EXISTS uq_provider_subscription;

ALTER TABLE subscriptions
    ADD CONSTRAINT uq_provider_subscription
    UNIQUE(payment_provider, provider_subscription_id);

-- ------------------------------------------------------------
-- Subscription indexes
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_subscriptions_profile_id
    ON subscriptions(profile_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
    ON subscriptions(subscription_status);

CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_customer
    ON subscriptions(provider_customer_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_current_period_end
    ON subscriptions(current_period_end);


-- ============================================================
-- PAYMENT WEBHOOK EVENTS TABLE
-- Raw provider webhook audit trail
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    payment_provider payment_provider_enum NOT NULL,

    event_type TEXT NOT NULL,

    provider_event_id TEXT NOT NULL,

    payload JSONB NOT NULL,

    processed BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMP NOT NULL DEFAULT NOW(),

    processed_at TIMESTAMP NULL
);

-- ------------------------------------------------------------
-- Prevent duplicate webhook processing
-- ------------------------------------------------------------

ALTER TABLE payment_webhook_events
    DROP CONSTRAINT IF EXISTS uq_provider_event;

ALTER TABLE payment_webhook_events
    ADD CONSTRAINT uq_provider_event
    UNIQUE(payment_provider, provider_event_id);

-- ------------------------------------------------------------
-- Webhook indexes
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_webhooks_processed
    ON payment_webhook_events(processed);

CREATE INDEX IF NOT EXISTS idx_webhooks_created_at
    ON payment_webhook_events(created_at);

CREATE INDEX IF NOT EXISTS idx_webhooks_provider
    ON payment_webhook_events(payment_provider);


-- ============================================================
-- CREDIT TRANSACTION IMPROVEMENTS
-- ============================================================

-- ------------------------------------------------------------
-- Link credit transactions to payments
-- ------------------------------------------------------------

ALTER TABLE credit_transactions
    ADD COLUMN IF NOT EXISTS reference_payment_id UUID NULL
        REFERENCES payments(id)
        ON DELETE SET NULL;

-- ------------------------------------------------------------
-- Prevent impossible balances
-- ------------------------------------------------------------

ALTER TABLE credit_transactions
    DROP CONSTRAINT IF EXISTS chk_credit_balance_consistency;

ALTER TABLE credit_transactions
    ADD CONSTRAINT chk_credit_balance_consistency
    CHECK (balance_after >= 0);

-- ------------------------------------------------------------
-- Index for payment linkage
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_credit_transactions_payment_id
    ON credit_transactions(reference_payment_id);


-- ============================================================
-- RECOMMENDED PAYMENT FLOW NOTES
-- ============================================================

-- SUCCESS PAYMENT FLOW:
--
-- 1. Insert webhook event
-- 2. Verify webhook signature
-- 3. Insert/update payments row
-- 4. Lock profile row FOR UPDATE
-- 5. Update profiles.current_credit_balance
-- 6. Insert credit_transactions row
-- 7. Mark webhook processed
-- 8. COMMIT
--
--
-- NEVER trust frontend payment success directly.
-- ALWAYS verify using provider webhook/server verification.


COMMIT;