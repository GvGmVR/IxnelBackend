// src/controllers/payments.controller.ts
import { Request, Response } from 'express';
import { paymentService } from '../services/payment.service';
import { paddleService } from '../services/paddle.service';
import { pool } from '../config/db';

export const paymentsController = {
  /**
   * Generates a transaction checkout session for an authenticated user.
   * POST /api/payments/create-checkout
   */
  createCheckout: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id, email } = req.user!; // Destructures snake_case payload from verified req.user JwtPayload
      const { priceId } = req.body;

      if (!priceId) {
        res.status(400).json({ success: false, error: 'priceId is required' });
        return;
      }

      console.log(`[paymentsController][createCheckout] Generating session for user: ${profile_id}`);
      
      const session = await paymentService.createCheckoutSession(profile_id, email, priceId);

      res.status(200).json({
        success: true,
        ...session
      });
    } catch (error) {
      console.error('[paymentsController][createCheckout] Error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error while initiating checkout session'
      });
    }
  },

  /**
   * Processes the raw webhook events received directly from Paddle.
   * POST /api/payments/webhook/paddle
   */
  handlePaddleWebhook: async (req: Request, res: Response): Promise<void> => {
    const signatureHeader = req.headers['paddle-signature'] as string;
    
    if (!signatureHeader) {
      console.warn('[paymentsController][handlePaddleWebhook] Missing paddle-signature header');
      res.status(400).json({ success: false, error: 'Missing paddle-signature header' });
      return;
    }

    try {
      // 1. Extract the raw body buffer attached during express.json verification
      const rawBody = (req as any).rawBody 
        ? (req as any).rawBody.toString('utf8') 
        : (req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body));

        // ─── DIAGNOSTIC LOGS (To traceback the issue in your console) ───
      console.log('------------------ WEBHOOK DIAGNOSTICS ------------------');
      console.log('[DEBUG] Webhook rawBody Length:', rawBody?.length);
      console.log('[DEBUG] Is rawBody populated via Buffer?', !!(req as any).rawBody);
      console.log('[DEBUG] Secret Key prefix:', process.env.PADDLE_WEBHOOK_SECRET_KEY?.substring(0, 10));
      console.log('[DEBUG] Signature Header preview:', signatureHeader?.substring(0, 20));
      console.log('---------------------------------------------------------');

      // 2. Await signature verification (resolves Promise<EventEntity | null>)
      const event = await paddleService.verifyWebhookSignature(rawBody, signatureHeader);
      if (!event) {
        res.status(401).json({ success: false, error: 'Invalid webhook signature verification failed' });
        return;
      }

      // 3. Extract normalized properties from resolved EventEntity
      const eventId = event.eventId;
      const eventType = event.eventType;

      console.log(`[paymentsController][handlePaddleWebhook] Verified Event: ${eventId} [${eventType}]`);

      // 4. Pass verified event to transaction pipeline
      await paymentService.processWebhookEvent('paddle', eventId, eventType, event);

      // 5. Respond 200 OK back to Paddle to confirm receipt immediately
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('[paymentsController][handlePaddleWebhook] Webhook handling crashed:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Internal server error processing webhook payload' 
      });
    }
  }, 

   /**
   * Safely cancels the active subscription record for the authenticated profile [1.2.4].
   * POST /api/payments/cancel-subscription
   */
  cancelSubscription: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      
      console.log(`[paymentsController][cancelSubscription] Processing cancellation for profile: ${profile_id}`);

      // Update status to 'cancelled' inside your subscriptions table
      const result = await pool.query(`
        UPDATE subscriptions
        SET subscription_status = 'cancelled', updated_at = NOW()
        WHERE profile_id = $1 AND subscription_status IN ('active', 'trialing', 'past_due')
        RETURNING id;
      `, [profile_id]);

      if (result.rowCount === 0) {
        res.status(404).json({ success: false, error: 'No active subscription found to cancel.' });
        return;
      }

      res.status(200).json({ success: true, message: 'Subscription canceled successfully.' });
    } catch (error) {
      console.error('[paymentsController][cancelSubscription] Error:', error);
      res.status(500).json({ success: false, error: 'Internal server error during cancellation' });
    }
  }
};  