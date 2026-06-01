// src/repositories/payment.repository.ts
import { Pool, PoolClient } from 'pg';
import { pool } from '../config/db';

export interface InsertPaymentInput {
  profile_id: string;
  payment_provider: 'paddle' | 'razorpay';
  provider_transaction_id: string;
  amount: number;
  payment_status: 'pending' | 'processing' | 'completed' | 'cancelled' | 'chargeback'; // Aligned to payment_status
  currency_code?: string;
  payment_type?: 'credit_purchase' | 'subscription' | 'addon_purchase' | 'enterprise_invoice';
  provider_customer_id?: string | null;
  provider_fee?: number | null;
  tax_amount?: number | null;
  metadata?: any;
  credits_added?: number | null; // Aligned to your schema column
}

export const paymentRepository = {
  /**
   * Inserts a payment record matching your exact PostgreSQL columns [1.2.4].
   */
  insertPayment: async (
    data: InsertPaymentInput,
    client: PoolClient | Pool = pool,
  ) => {
    const query = `
      INSERT INTO payments (
        profile_id, payment_provider, provider_transaction_id, amount, payment_status,
        currency_code, payment_type, provider_customer_id, provider_fee, tax_amount, metadata, credits_added
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (payment_provider, provider_transaction_id) 
      DO UPDATE SET 
        payment_status = EXCLUDED.payment_status,
        provider_customer_id = COALESCE(payments.provider_customer_id, EXCLUDED.provider_customer_id),
        metadata = COALESCE(payments.metadata, EXCLUDED.metadata),
        credits_added = COALESCE(payments.credits_added, EXCLUDED.credits_added)
      RETURNING id, profile_id, payment_provider, provider_transaction_id, amount, payment_status, credits_added;
    `;
    
    const values = [
      data.profile_id,
      data.payment_provider,
      data.provider_transaction_id,
      data.amount,
      data.payment_status,
      data.currency_code || 'USD',
      data.payment_type || 'credit_purchase',
      data.provider_customer_id || null,
      data.provider_fee || null,
      data.tax_amount || null,
      data.metadata ? JSON.stringify(data.metadata) : null,
      data.credits_added !== undefined && data.credits_added !== null ? data.credits_added : null
    ];

    const result = await client.query(query, values);
    return result.rows[0];
  },

  /**
   * Locks the target user profile row FOR UPDATE.
   * Fetches both subscription_credits and purchased_credits [1.2.4].
   */
  lockProfileForUpdate: async (
    profileId: string,
    client: PoolClient,
  ): Promise<{ 
    id: string; 
    current_credit_balance: number;
    subscription_credits: number;
    purchased_credits: number;
  }> => {
    const query = `
      SELECT id, current_credit_balance, subscription_credits, purchased_credits 
      FROM profiles 
      WHERE id = $1 
      FOR UPDATE;
    `;
    const result = await client.query(query, [profileId]);
    if (!result.rows[0]) {
      throw new Error(`Profile ${profileId} not found for transactional lock`);
    }
    return result.rows[0];
  },

  /**
   * Updates all three synchronized profile credit columns [1.2.4].
   */
  updateProfileBalance: async (
    profileId: string,
    subscriptionCredits: number,
    purchasedCredits: number,
    client: PoolClient,
  ): Promise<void> => {
    const totalBalance = subscriptionCredits + purchasedCredits;
    const query = `
      UPDATE profiles
      SET 
        subscription_credits = $1,
        purchased_credits = $2,
        current_credit_balance = $3,
        updated_at = NOW()
      WHERE id = $4;
    `;
    await client.query(query, [subscriptionCredits, purchasedCredits, totalBalance, profileId]);
  },

  /**
   * Inserts a record into credit_transactions linked directly to the purchase payment [1.2.4].
   */
  insertCreditTransaction: async (
    data: {
      profile_id: string;
      transaction_type: 'purchase' | 'free_grant' | 'usage';
      amount: number;
      balance_after: number;
      notes: string;
      reference_payment_id?: string;
    },
    client: PoolClient | Pool = pool,
  ): Promise<void> => {
    const query = `
      INSERT INTO credit_transactions 
        (profile_id, transaction_type, amount, balance_after, notes, reference_payment_id)
      VALUES 
        ($1, $2, $3, $4, $5, $6);
    `;
    const values = [
      data.profile_id,
      data.transaction_type,
      data.amount,
      data.balance_after,
      data.notes,
      data.reference_payment_id || null
    ];
    await client.query(query, values);
  }
};