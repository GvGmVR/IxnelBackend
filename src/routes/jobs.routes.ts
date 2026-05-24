import { Router } from 'express';

import {
  submitJob,
  getMyJobs,
  getJobById,
  cancelJob,
  getJobStatus,
} from '../controllers/jobs.controller';

import { requireAuth }    from '../middleware/requireAuth';
import { requireCredits } from '../middleware/requireCredits';

const router = Router();

// All job routes require authentication
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/jobs/submit
// Submit a new AI processing job
// requireCredits middleware checks available balance before controller runs
// ─────────────────────────────────────────────────────────────────────────────
router.post('/submit', requireCredits, submitJob);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/jobs
// Get all jobs for logged-in user
// Query params: ?status=queued&page=1&limit=10
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', getMyJobs);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/jobs/:id
// Get single job details by job ID
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', getJobById);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/jobs/:id/status
// Lightweight status polling endpoint
// Frontend polls this to track job progress
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/status', getJobStatus);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/jobs/:id/cancel
// Cancel a queued job (only if status = queued)
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/cancel', cancelJob);

export default router;