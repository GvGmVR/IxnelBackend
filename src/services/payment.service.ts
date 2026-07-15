// src/services/payment.service.ts
import { pool } from '../config/db';
import { paddleService } from './paddle.service';
import { webhookRepository } from '../repositories/webhook.repository';
import { paymentRepository } from '../repositories/payment.repository';
import { subscriptionRepository } from '../repositories/subscription.repository';

// ─── SUBSCRIPTION PRICE IDS ───
const soloMonthlyId = (process.env.PADDLE_PRICE_ID_SOLO_MONTHLY || '').replace(/['"]/g, '').trim();
const soloYearlyId = (process.env.PADDLE_PRICE_ID_SOLO_YEARLY || '').replace(/['"]/g, '').trim();
const studioMonthlyId = (process.env.PADDLE_PRICE_ID_STUDIO_MONTHLY || '').replace(/['"]/g, '').trim();
const studioYearlyId = (process.env.PADDLE_PRICE_ID_STUDIO_YEARLY || '').replace(/['"]/g, '').trim();

// ─── PREPAID CREDIT PACK PRICE IDS ───
const pack750Id = (process.env.PADDLE_PRICE_ID_PACK_750 || '').replace(/['"]/g, '').trim();
const pack2000Id = (process.env.PADDLE_PRICE_ID_PACK_2000 || '').replace(/['"]/g, '').trim();
const pack5000Id = (process.env.PADDLE_PRICE_ID_PACK_5000 || '').replace(/['"]/g, '').trim();
const pack12000Id = (process.env.PADDLE_PRICE_ID_PACK_12000 || '').replace(/['"]/g, '').trim();

// ─── MAPPINGS ───

// Prepaid Packs: Maps the price ID to the exact amount of non-expiring purchased_credits to add
const PRICE_TO_CREDITS_MAP: Record<string, number> = {
  [pack750Id]: 750,
  [pack2000Id]: 2000,
  [pack5000Id]: 5000,
  [pack12000Id]: 12000,
};

// Subscription Plans: Maps the price ID to the exact monthly subscription_credits allowance to grant
const SUB_PLAN_ALLOWANCE_MAP: Record<string, number> = {
  [soloMonthlyId]: 1500,
  [soloYearlyId]: 1500,
  [studioMonthlyId]: 6000,
  [studioYearlyId]: 6000,
};

export const paymentService = {
  createCheckoutSession: async (profileId: string, email: string, priceId: string) => {
    return paddleService.createTransaction(priceId, email, profileId);
  },

  /**
   * Automated Background Task [1.2.4]
   * Cumulative Renewal: Adds 500 credits on top of their existing subscription_credits [1.2.4].
   */
  runDailyCreditRenewal: async (): Promise<void> => {
    console.log('[paymentService][runDailyCreditRenewal] Initiating automated subscription check...');
    const dueSubscriptions = await subscriptionRepository.findDueRenewals();

    if (dueSubscriptions.length === 0) {
      console.log('[paymentService][runDailyCreditRenewal] No subscriptions are currently due for renewal.');
      return;
    }

    console.log(`[paymentService][runDailyCreditRenewal] Found ${dueSubscriptions.length} subscriptions due for credit reset.`);

    for (const sub of dueSubscriptions) {
      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');

        const monthlyAllowance = SUB_PLAN_ALLOWANCE_MAP[sub.plan_code];
        if (monthlyAllowance) {
          const profile = await paymentRepository.lockProfileForUpdate(sub.profile_id, dbClient);
          
          // Cumulative Addition: Adds 500 to existing subscription credits [1.2.4]
          const cumulativeSubscriptionCredits = profile.subscription_credits + monthlyAllowance;
          await paymentRepository.updateProfileBalance(sub.profile_id, cumulativeSubscriptionCredits, profile.purchased_credits, dbClient);

          await paymentRepository.insertCreditTransaction({
            profile_id: sub.profile_id,
            transaction_type: 'free_grant',
            amount: monthlyAllowance,
            balance_after: cumulativeSubscriptionCredits + profile.purchased_credits,
            notes: `Automated monthly plan renewal: ${monthlyAllowance} credits added`
          }, dbClient);

          await subscriptionRepository.updateLastRenewedDate(sub.id, dbClient);
          console.log(`[paymentService][runDailyCreditRenewal] Successfully renewed credits for profile: ${sub.profile_id}`);
        }

        await dbClient.query('COMMIT');
      } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error(`[paymentService][runDailyCreditRenewal] Failed to renew credits for subscription ${sub.id}:`, error);
      } finally {
        dbClient.release();
      }
    }
  },

  processWebhookEvent: async (
    provider: 'paddle' | 'razorpay',
    eventId: string,
    eventType: string,
    payload: any,
  ): Promise<boolean> => {
    const dbClient = await pool.connect();

    try {
      const existing = await webhookRepository.findEvent(provider, eventId, dbClient);
      if (existing) {
        if (existing.processed) {
          console.log(`[paymentService][processWebhookEvent] Event ${eventId} was already processed. Skipping.`);
          return true;
        }
      } else {
        await webhookRepository.logEvent({ provider, eventId, eventType, payload }, dbClient);
      }

      await dbClient.query('BEGIN');

      // 1. Handle One-Time Credit Top-Ups and Subscription Payment logging
      if (provider === 'paddle' && eventType === 'transaction.completed') {
        const transactionDetails = payload.data;
        const profileId = transactionDetails.customData?.profileId;
        const transactionId = transactionDetails.id;
        const currencyCode = transactionDetails.currencyCode;
        const totalAmount = parseFloat(transactionDetails.details?.totals?.total || '0') / 100;
        const taxAmount = parseFloat(transactionDetails.details?.totals?.tax || '0') / 100;
        
        // 1. Extract the specific item and its quantity [1.2.4]
        const lineItem = transactionDetails.items?.[0];
        const priceId = lineItem?.price?.id;
        const quantity = lineItem?.quantity || 1; // Default to 1 if not provided [1.2.4]

        if (!profileId) {
          throw new Error(`No profileId found in transaction customData for ${transactionId}`);
        }

        const isSubscriptionPayment = SUB_PLAN_ALLOWANCE_MAP[priceId] !== undefined;
        // 2. Multiply base credits by the quantity purchased [1.2.4]
        const creditsToAward = (PRICE_TO_CREDITS_MAP[priceId] || 0) * quantity;

        console.log('[DEBUG] Evaluating Webhook Credits:', { 
            receivedPriceId: priceId, 
            quantity, 
            creditsToAward, 
            isSubscriptionPayment 
        });

        // 3. Insert the payment record with total credits awarded [1.2.4]
        const paymentRecord = await paymentRepository.insertPayment({
          profile_id: profileId,
          payment_provider: 'paddle',
          provider_transaction_id: transactionId,
          amount: totalAmount,
          payment_status: 'completed',
          currency_code: currencyCode,
          payment_type: isSubscriptionPayment ? 'subscription' : 'credit_purchase',
          provider_customer_id: transactionDetails.customerId,
          tax_amount: taxAmount,
          metadata: { priceId, quantity },
          credits_added: creditsToAward > 0 ? creditsToAward : null
        }, dbClient);

        // 4. Update the profile balances [1.2.4]
        if (creditsToAward > 0) {
          const profile = await paymentRepository.lockProfileForUpdate(profileId, dbClient);
          const updatedPurchasedCredits = profile.purchased_credits + creditsToAward;
          
          await paymentRepository.updateProfileBalance(profileId, profile.subscription_credits, updatedPurchasedCredits, dbClient);

          await paymentRepository.insertCreditTransaction({
            profile_id: profileId,
            transaction_type: 'purchase',
            amount: creditsToAward,
            balance_after: profile.subscription_credits + updatedPurchasedCredits,
            notes: `Purchased package: ${creditsToAward} credits via Paddle (Qty: ${quantity})`,
            reference_payment_id: paymentRecord.id
          }, dbClient);
        }
      }

      // 2. Handle Subscription Creation & Renewal [1.1.2, 1.2.4]
      if (provider === 'paddle' && (eventType === 'subscription.created' || eventType === 'subscription.updated')) {
        const subscriptionDetails = payload.data;
        const profileId = subscriptionDetails.customData?.profileId;
        const subscriptionId = subscriptionDetails.id;
        const customerId = subscriptionDetails.customerId;
        const planCode = subscriptionDetails.items?.[0]?.price?.id;
        const status = subscriptionDetails.status;
        const billingCycle = subscriptionDetails.billingCycle?.interval === 'year' ? 'yearly' : 'monthly';
        const periodStart = new Date(subscriptionDetails.currentBillingPeriod?.startsAt);
        const periodEnd = new Date(subscriptionDetails.currentBillingPeriod?.endsAt);
        const cancelAtPeriodEnd = !!subscriptionDetails.scheduledChange?.action;

        if (!profileId) {
          throw new Error(`No profileId found in subscription customData for ${subscriptionId}`);
        }

        console.log('[DEBUG] Evaluating Subscription webhook:', { subscriptionId, planCode, status });

        await subscriptionRepository.upsertSubscription({
          profile_id: profileId,
          payment_provider: 'paddle',
          provider_subscription_id: subscriptionId,
          provider_customer_id: customerId,
          plan_code: planCode,
          subscription_status: status,
          billing_cycle: billingCycle,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          cancel_at_period_end: cancelAtPeriodEnd
        }, dbClient);

        if (eventType === 'subscription.created'&& ['active', 'trialing'].includes(status)) {
          const monthlyAllowance = SUB_PLAN_ALLOWANCE_MAP[planCode];
          
          console.log('[DEBUG] Checking Plan Allowance Award:', { planCode, monthlyAllowance });

          if (monthlyAllowance) {
            const profile = await paymentRepository.lockProfileForUpdate(profileId, dbClient);
            
            // Cumulative Addition: Adds 500 to existing subscription credits [1.2.4]
            const cumulativeSubscriptionCredits = profile.subscription_credits + monthlyAllowance;
            await paymentRepository.updateProfileBalance(profileId, cumulativeSubscriptionCredits, profile.purchased_credits, dbClient);

            await paymentRepository.insertCreditTransaction({
              profile_id: profileId,
              transaction_type: 'free_grant',
              amount: monthlyAllowance,
              balance_after: cumulativeSubscriptionCredits + profile.purchased_credits,
              notes: `Monthly plan reset: ${monthlyAllowance} credits granted for Pro Plan`
            }, dbClient);
          }
        }
      }

      await webhookRepository.markProcessed(provider, eventId, dbClient);
      await dbClient.query('COMMIT');
      return true;

    } catch (error) {
      await dbClient.query('ROLLBACK');
      console.error(`[paymentService][processWebhookEvent] Transaction aborted. Rollback executed. Error:`, error);
      throw error;
    } finally {
      dbClient.release();
    }
  }
};