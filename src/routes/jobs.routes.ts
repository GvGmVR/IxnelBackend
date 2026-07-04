// src/routes/jobs.routes.ts

import { Router } from 'express';
import { jobsController } from '../controllers/jobs.controller'; 
import { requireAuth }    from '../middleware/requireAuth';
import multer from 'multer';
import rateLimit from 'express-rate-limit'; // Imported locally

const upload = multer(); // Memory storage configuration
const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// SELF-CONTAINED ROUTE LIMITERS (Avoids circular imports with server.ts)
// ─────────────────────────────────────────────────────────────────────────────

// Strictly limits job submissions to prevent spam (10 submissions per minute max)
const jobLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,
  message: { success: false, error: 'Job submission limit reached, slow down.' }
});

// Relaxed progress status check limits (allows up to 60 polls per minute)
const statusPollingLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60,
  message: { success: false, error: 'Too many status checks. Please wait.' }
});


// All job routes require authentication
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/jobs/submit
// Submit a new AI processing job
// ─────────────────────────────────────────────────────────────────────────────
router.post('/submit', jobLimiter, upload.any(), jobsController.submitJob);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/jobs
// Get all jobs for logged-in user
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', jobsController.getMyJobs);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/jobs/:id
// Get single job details by job ID
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', jobsController.getJobById);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/jobs/:id/status
// Lightweight status polling endpoint protected by statusPollingLimiter
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/status', statusPollingLimiter, jobsController.getJobStatus);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/jobs/:id/cancel
// Cancel a queued job (only if status = queued or blocked)
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/cancel', jobsController.cancelJob);

export default router;