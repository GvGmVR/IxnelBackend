// src/routes/feedback.routes.ts
import { Router } from 'express';
import { feedbackController } from '../controllers/feedback.controller';
import { requireAuth } from '../middleware/requireAuth';

const router = Router();

// POST /api/feedback - Gated to logged-in members to prevent automated bot spam
router.post('/', requireAuth, feedbackController.submitFeedback);

export default router;