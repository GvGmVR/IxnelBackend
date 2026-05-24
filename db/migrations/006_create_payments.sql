-- ============================================================
-- 006_create_payments.sql
-- Real money payment tracking
-- ============================================================

CREATE TABLE payments (
    id                      UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id              UUID                    NOT NULL REFERENCES profiles(id)
                                                        ON DELETE CASCADE,
    amount                  DECIMAL(10, 2)          NOT NULL,           -- real money amount
    credits_added           INTEGER                 NOT NULL,           -- credits granted on success
    payment_provider        payment_provider_enum   NOT NULL,
    payment_status          payment_status_enum     NOT NULL DEFAULT 'pending',
    provider_transaction_id TEXT                    NOT NULL,           -- from razorpay/stripe etc
    created_at              TIMESTAMP               NOT NULL DEFAULT NOW(),
    completed_at            TIMESTAMP               NULL                -- when payment confirmed
);

-- ============================================================
-- CONSTRAINTS
-- ============================================================

-- Amount must be positive
ALTER TABLE payments
    ADD CONSTRAINT chk_payment_amount_positive
    CHECK (amount > 0);

-- Credits added must be positive
ALTER TABLE payments
    ADD CONSTRAINT chk_credits_added_positive
    CHECK (credits_added > 0);

-- completed_at only when terminal status
ALTER TABLE payments
    ADD CONSTRAINT chk_payment_completed_at_terminal
    CHECK (
        (completed_at IS NULL)
        OR
        (payment_status IN ('success', 'failed', 'refunded'))
    );

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_payments_profile_id
    ON payments(profile_id);

CREATE INDEX idx_payments_status
    ON payments(payment_status);

CREATE INDEX idx_payments_provider_transaction_id
    ON payments(provider_transaction_id);

CREATE INDEX idx_payments_created_at
    ON payments(created_at);

-- ============================================================
-- PAYMENT LOGIC REFERENCE
-- ============================================================

-- On success  → credits += credits_added
--             → insert credit_transaction (type = purchase)
-- On failure  → do NOT modify credits
-- On refund   → credits adjusted via credit_transaction (type = refund)