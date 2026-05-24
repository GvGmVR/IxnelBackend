import { Router } from 'express';

import {
  initiatePayment,
  verifyPayment,
  getMyPayments,
  getPaymentById,
} from '../controllers/payments.controller';

import { requireAuth } from '../middleware/requireAuth';

const router = Router();

// All payment routes require authentication
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/initiate
// Start a payment session with provider (razorpay/stripe)
// Body: { amount, payment_provider }
// Returns: provider order/session id
// ─────────────────────────────────────────────────────────────────────────────
router.post('/initiate', initiatePayment);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/verify
// Verify payment after frontend confirms
// Body: { provider_transaction_id, payment_provider }
// On success → credits added → transaction logged
// ─────────────────────────────────────────────────────────────────────────────
router.post('/verify', verifyPayment);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments
// Payment history for logged-in user
// Query params: ?status=success&page=1&limit=10
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', getMyPayments);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/:id
// Single payment detail
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', getPaymentById);

export default router;