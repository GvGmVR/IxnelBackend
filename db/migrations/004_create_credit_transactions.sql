-- ============================================================
-- 004_create_credit_transactions.sql
-- Full credit accounting trail
-- Every credit movement recorded here
-- ============================================================

CREATE TABLE credit_transactions (
    id                  UUID                            PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id          UUID                            NOT NULL REFERENCES profiles(id)
                                                            ON DELETE CASCADE,
    transaction_type    credit_transaction_type_enum    NOT NULL,
    amount              INTEGER                         NOT NULL,
    balance_after       INTEGER                         NOT NULL,   -- snapshot after transaction
    reference_job_id    UUID                            NULL,       -- links to jobs table if relevant
    notes               TEXT                            NULL,
    created_at          TIMESTAMP                       NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CONSTRAINTS
-- ============================================================

-- Amount should not be zero
ALTER TABLE credit_transactions
    ADD CONSTRAINT chk_transaction_amount_nonzero
    CHECK (amount != 0);

-- Balance after should never be negative
ALTER TABLE credit_transactions
    ADD CONSTRAINT chk_balance_after_non_negative
    CHECK (balance_after >= 0);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_credit_transactions_profile_id
    ON credit_transactions(profile_id);

CREATE INDEX idx_credit_transactions_type
    ON credit_transactions(transaction_type);

CREATE INDEX idx_credit_transactions_reference_job_id
    ON credit_transactions(reference_job_id);

CREATE INDEX idx_credit_transactions_created_at
    ON credit_transactions(created_at);

-- ============================================================
-- TRANSACTION TYPE REFERENCE
-- ============================================================

-- free_grant          → signup bonus credits
-- purchase            → real money credit purchase
-- job_deduction       → credits permanently deducted after job success
-- refund              → credits returned
-- admin_adjustment    → manual admin correction
-- reservation         → credits locked when job starts
-- reservation_release → credits unlocked when job fails