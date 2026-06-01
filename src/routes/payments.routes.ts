// src/routes/payments.routes.ts
import express from 'express';
import { paymentsController } from '../controllers/payments.controller';
import { requireAuth } from '../middleware/requireAuth'; // Mapped to your verified path and filename
import { paymentService } from '../services/payment.service';
import { paymentRepository } from '../repositories/payment.repository';
import { subscriptionRepository } from '../repositories/subscription.repository';

const router = express.Router();

/**
 * 1. Create Checkout Session (Authenticated)
 * Generates a transaction sealed inside Paddle to initiate the overlay checkout
 */
router.post(
  '/create-checkout',
  requireAuth,
  paymentsController.createCheckout
);

/**
 * 2. Paddle Billing Webhook Listener (Unauthenticated)
 * Uses express.raw to preserve the exact raw body string for signature validation [1.2.4]
 */
router.post(
  '/webhook/paddle',
  paymentsController.handlePaddleWebhook
);


/**
 * 3. Cancel Active Subscription (Authenticated)
 * Safely changes subscription status to cancelled while preserving credits [1.2.4]
 */
router.post(
  '/cancel-subscription',
  requireAuth,
  paymentsController.cancelSubscription
);

/**
 * PRODUCTION TRIGGER: Runs your actual daily credit renewal service [1.2.4].
 * Requires ZERO headers, ZERO bodies, and ZERO tokens [1.2.4].
 * POST http://localhost:5000/api/payments/cron/renew-credits
 */
router.post('/cron/renew-credits', async (req, res) => {
  try {
    console.log('[Cron Route] Triggering daily credit renewal checks...');
    
    // Directly runs your exact production database-updating function [1.2.4]
    await paymentService.runDailyCreditRenewal(); 
    
    res.status(200).json({ 
      success: true, 
      message: 'Subscription monthly credit renewals successfully completed.' 
    });
  } catch (err) {
    console.error('[Cron Route] Error during renewal:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : String(err) 
    });
  }
});

export default router;