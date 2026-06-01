// src/services/paddle.service.ts
import { paddleClient, paddleConfig } from '../config/paddle';
import { EventEntity } from '@paddle/paddle-node-sdk';

export const paddleService = {
  /**
   * Generates a sealed transaction inside Paddle's systems.
   * Seals customData (like profileId) so it cannot be tampered with on the frontend [1.2.4].
   */
  createTransaction: async (priceId: string, email: string, profileId: string) => {
    try {
      const transaction = await paddleClient.transactions.create({
        items: [{ priceId, quantity: 1 }],
        customData: { profileId }, // Seals the internal user profile ID inside Paddle's transaction object
      });

      return {
        transactionId: transaction.id,
        priceId: priceId,
        email,
      };
    } catch (error) {
      console.error('[paddleService][createTransaction] Error generating transaction:', error);
      throw error;
    }
  },

  /**
   * Cryptographically verifies that the webhook payload is authentic and was sent by Paddle [1.2.4].
   * unmarshal returns a Promise in modern versions of the SDK.
   */
  verifyWebhookSignature: async (rawBody: string, signatureHeader: string): Promise<EventEntity | null> => {
    try {
      // Await the asynchronous unmarshal call to resolve the Promise<EventEntity> [1.2.4]
      const event = await paddleClient.webhooks.unmarshal(rawBody, paddleConfig.webhookSecret, signatureHeader);
      return event;
    } catch (error) {
      console.error('[paddleService][verifyWebhookSignature] Signature verification failed:', error);
      return null;
    }
  }
};