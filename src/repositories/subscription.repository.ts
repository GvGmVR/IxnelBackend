// src/repositories/subscription.repository.ts
import { Pool, PoolClient } from 'pg';
import { pool } from '../config/db';

export interface SubscriptionRecord {
  id: string;
  profile_id: string;
  payment_provider: 'paddle' | 'razorpay';
  provider_subscription_id: string;
  provider_customer_id: string;
  plan_code: string;
  subscription_status: 'active' | 'cancelled' | 'past_due' | 'trialing' | 'expired';
  billing_cycle: 'monthly' | 'yearly';
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  last_renewed_at: Date;
  created_at: Date;
  updated_at: Date;
}

export const subscriptionRepository = {
  upsertSubscription: async (
    data: Omit<SubscriptionRecord, 'id' | 'created_at' | 'updated_at' | 'last_renewed_at'>,
    client: PoolClient | Pool = pool,
  ): Promise<SubscriptionRecord> => {
    const query = `
      INSERT INTO subscriptions (
        profile_id, payment_provider, provider_subscription_id, provider_customer_id,
        plan_code, subscription_status, billing_cycle, current_period_start,
        current_period_end, cancel_at_period_end, last_renewed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (payment_provider, provider_subscription_id)
      DO UPDATE SET
        subscription_status = EXCLUDED.subscription_status,
        plan_code = EXCLUDED.plan_code,
        current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        updated_at = NOW()
      RETURNING *;
    `;
    
    const values = [
      data.profile_id,
      data.payment_provider,
      data.provider_subscription_id,
      data.provider_customer_id,
      data.plan_code,
      data.subscription_status,
      data.billing_cycle,
      data.current_period_start,
      data.current_period_end,
      data.cancel_at_period_end
    ];

    const result = await client.query(query, values);
    return result.rows[0];
  },

  updateLastRenewedDate: async (
    subscriptionId: string,
    client: PoolClient | Pool = pool,
  ): Promise<void> => {
    const query = `
      UPDATE subscriptions
      SET last_renewed_at = NOW(), updated_at = NOW()
      WHERE id = $1;
    `;
    await client.query(query, [subscriptionId]);
  },

  findDueRenewals: async (
    client: PoolClient | Pool = pool,
  ): Promise<SubscriptionRecord[]> => {
    const query = `
      SELECT * FROM subscriptions
      WHERE 
        subscription_status IN ('active', 'trialing')
        AND last_renewed_at <= NOW() - INTERVAL '1 month';
    `;
    const result = await client.query(query);
    return result.rows;
  }
};