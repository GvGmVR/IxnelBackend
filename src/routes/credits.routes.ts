import { Router } from 'express';

import {
  getCreditBalance,
  getCreditTransactions,
  getCreditTransactionById,
} from '../controllers/credits.controller';

import { requireAuth } from '../middleware/requireAuth';

const router = Router();

// All credit routes require authentication
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/credits/balance
// Returns current credits, reserved_credits, available_credits
// ─────────────────────────────────────────────────────────────────────────────
router.get('/balance', getCreditBalance);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/credits/transactions
// Full credit transaction history for logged-in user
// Query params: ?type=purchase&page=1&limit=20
// ─────────────────────────────────────────────────────────────────────────────
router.get('/transactions', getCreditTransactions);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/credits/transactions/:id
// Single transaction detail
// ─────────────────────────────────────────────────────────────────────────────
router.get('/transactions/:id', getCreditTransactionById);

export default router;