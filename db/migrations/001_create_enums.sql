-- ============================================================
-- 001_create_enums.sql
-- All ENUM types used across the database
-- Must run BEFORE table creation
-- ============================================================

-- Auth provider types
CREATE TYPE auth_provider_enum AS ENUM (
    'local',
    'google',
    'github'
);

-- User/profile types
CREATE TYPE user_type_enum AS ENUM (
    'individual',
    'company'
);

-- Credit transaction types
CREATE TYPE credit_transaction_type_enum AS ENUM (
    'free_grant',
    'purchase',
    'job_deduction',
    'refund',
    'admin_adjustment',
    'reservation',
    'reservation_release'
);

-- Job lifecycle status
CREATE TYPE job_status_enum AS ENUM (
    'queued',
    'initiated',
    'processing',
    'completed',
    'failed',
    'blocked',
    'cancelled'
);

-- Payment status
CREATE TYPE payment_status_enum AS ENUM (
    'pending',
    'success',
    'failed',
    'refunded'
);

-- Payment providers
CREATE TYPE payment_provider_enum AS ENUM (
    'razorpay',
    'stripe',
    'paypal',
    'manual'
);