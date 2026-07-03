// src/routes/external.routes.ts
import { Router } from 'express';
import { externalController } from '../controllers/external.controller';
import { requireApiKey } from '../middleware/requireApiKey';
import { requireCepClient } from '../middleware/requireCepClient'
import multer from 'multer';

const upload = multer(); // Memory storage configuration
const router = Router();

// All external API routes require a verified API Key in headers
router.use(requireCepClient);
router.use(requireApiKey);

// POST /api/v1/external/submit
router.post('/submit', upload.any(), externalController.submitExternalJob);

// GET /api/v1/external/jobs/:id/status
router.get('/jobs/:id/status', externalController.getExternalJobStatus);

// PATCH /api/v1/external/jobs/:id/cancel
router.patch('/jobs/:id/cancel', externalController.cancelExternalJob);

// GET /api/v1/external/balance
router.get('/balance', externalController.getExternalBalance);

// GET /api/v1/external/jobs
router.get('/jobs', externalController.getMyJobs);

// Add this route entry inside your external routes configuration alongside getMyJobs:
router.delete('/jobs/cleanup', externalController.clearUnsuccessfulJobs);

router.delete('/jobs/:id', externalController.deleteExternalJob);

export default router;