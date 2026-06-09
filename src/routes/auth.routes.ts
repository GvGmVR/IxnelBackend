// auth.routes.ts

import { Router } from 'express';
import {
  registerLocal,
  loginLocal,
  oauthCallback,
  verifyEmail,
  forgotPassword,
  resetPassword,
  refreshToken,
  logout,
  getMe,
} from '../controllers/auth.controller';
import { requireAuth } from '../middleware/requireAuth';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES — no token required
// ─────────────────────────────────────────────────────────────────────────────

router.post('/register',        registerLocal);
router.post('/login',           loginLocal);
router.post('/oauth/callback',  oauthCallback);
router.get ('/verify-email',    verifyEmail);    // ← GET, not POST — token in query param
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/refresh',         refreshToken);

// ─────────────────────────────────────────────────────────────────────────────
// PROTECTED ROUTES — requireAuth runs first
// ─────────────────────────────────────────────────────────────────────────────

router.post('/logout', requireAuth, logout);
router.get ('/me',     requireAuth, getMe);

export default router;