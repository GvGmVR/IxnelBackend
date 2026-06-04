// src/routes/jobs.routes.ts

import { Router } from 'express';
import { jobsController } from '../controllers/jobs.controller'; // Aligned to the unified controller object [1]
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
router.post('/submit', requireCredits, jobsController.submitJob);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/jobs
// Get all jobs for logged-in user
// Query params: ?status=queued&page=1&limit=10
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', jobsController.getMyJobs);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/jobs/:id
// Get single job details by job ID
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', jobsController.getJobById);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/jobs/:id/status
// Lightweight status polling endpoint
// Frontend polls this to track job progress
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/status', jobsController.getJobStatus);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/jobs/:id/cancel
// Cancel a queued job (only if status = queued or blocked) [1.2.4]
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/cancel', jobsController.cancelJob);

export default router;