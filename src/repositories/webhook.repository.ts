// src/repositories/webhook.repository.ts
import { Pool, PoolClient } from 'pg';
import { pool } from '../config/db';

export interface WebhookEventRecord {
  id: string;
  payment_provider: 'paddle' | 'razorpay';
  event_type: string;
  provider_event_id: string;
  payload: any;
  processed: boolean;
  created_at: Date;
  processed_at: Date | null;
}

export const webhookRepository = {
  /**
   * Logs an incoming webhook event into the audit trail.
   * Leverages the unique constraint to block duplicate incoming events at the DB level.
   */
  logEvent: async (
    data: {
      provider: 'paddle' | 'razorpay';
      eventId: string;
      eventType: string;
      payload: any;
    },
    client: PoolClient | Pool = pool,
  ): Promise<WebhookEventRecord> => {
    const query = `
      INSERT INTO payment_webhook_events 
        (payment_provider, provider_event_id, event_type, payload, processed)
      VALUES 
        ($1, $2, $3, $4, FALSE)
      RETURNING 
        id, payment_provider, provider_event_id, event_type, payload, processed, created_at, processed_at;
    `;
    const values = [data.provider, data.eventId, data.eventType, JSON.stringify(data.payload)];
    const result = await client.query(query, values);
    return result.rows[0];
  },

  /**
   * Checks if a webhook event exists and whether it has already been processed.
   */
  findEvent: async (
    provider: 'paddle' | 'razorpay',
    eventId: string,
    client: PoolClient | Pool = pool,
  ): Promise<WebhookEventRecord | null> => {
    const query = `
      SELECT id, payment_provider, provider_event_id, event_type, payload, processed, created_at, processed_at
      FROM payment_webhook_events
      WHERE payment_provider = $1 AND provider_event_id = $2;
    `;
    const result = await client.query(query, [provider, eventId]);
    return result.rows[0] || null;
  },

  /**
   * Marks a logged webhook event as processed with a timestamp.
   */
  markProcessed: async (
    provider: 'paddle' | 'razorpay',
    eventId: string,
    client: PoolClient | Pool = pool,
  ): Promise<void> => {
    const query = `
      UPDATE payment_webhook_events
      SET processed = TRUE, processed_at = NOW()
      WHERE payment_provider = $1 AND provider_event_id = $2;
    `;
    await client.query(query, [provider, eventId]);
  }
};