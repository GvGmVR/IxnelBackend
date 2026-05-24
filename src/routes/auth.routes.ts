import { Router } from 'express';

// Controllers (implement logic later)
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
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/register
// Local email + password registration
router.post('/register', registerLocal);

// POST /api/auth/login
// Local email + password login
router.post('/login', loginLocal);

// POST /api/auth/oauth/callback
// OAuth provider callback (google, github)
// Body: { provider, provider_user_id, email, username? }
router.post('/oauth/callback', oauthCallback);

// GET /api/auth/verify-email?token=xxx
// Email verification link handler
router.get('/verify-email', verifyEmail);

// POST /api/auth/forgot-password
// Sends reset link to email
router.post('/forgot-password', forgotPassword);

// POST /api/auth/reset-password
// Resets password with valid token
router.post('/reset-password', resetPassword);

// POST /api/auth/refresh
// Refreshes access token using refresh token
router.post('/refresh', refreshToken);

// ─────────────────────────────────────────────────────────────────────────────
// PROTECTED ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/logout
// Invalidates session / refresh token
router.post('/logout', requireAuth, logout);

// GET /api/auth/me
router.get('/me', requireAuth, getMe);

export default router;