import { Router } from 'express';

import {
  getAllUsers,
  getUserById,
  blockUser,
  unblockUser,
  adjustCredits,
  getAllJobs,
  getAllPayments,
} from '../controllers/admin.controller';

import { requireAuth }  from '../middleware/requireAuth';
import { requireAdmin } from '../middleware/requireAdmin';

const router = Router();

// All admin routes require auth + admin role
router.use(requireAuth);
router.use(requireAdmin);

// ─────────────────────────────────────────────────────────────────────────────
// USER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// GET  /api/admin/users
router.get('/users', getAllUsers);

// GET  /api/admin/users/:id
router.get('/users/:id', getUserById);

// PATCH /api/admin/users/:id/block
router.patch('/users/:id/block', blockUser);

// PATCH /api/admin/users/:id/unblock
router.patch('/users/:id/unblock', unblockUser);

// ─────────────────────────────────────────────────────────────────────────────
// CREDIT MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/admin/credits/adjust
// Body: { profile_id, amount, notes }
// Can add or deduct credits manually
router.post('/credits/adjust', adjustCredits);

// ─────────────────────────────────────────────────────────────────────────────
// JOB OVERSIGHT
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/jobs
// Query: ?status=failed&page=1&limit=20
router.get('/jobs', getAllJobs);

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT OVERSIGHT
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/payments
router.get('/payments', getAllPayments);

export default router;