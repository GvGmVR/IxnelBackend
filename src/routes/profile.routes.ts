import { Router } from 'express';

import {
  getMyProfile,
  updateMyProfile,
  getProfileByUsername,
} from '../controllers/profile.controller';

import { requireAuth } from '../middleware/requireAuth';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// PROTECTED - own profile
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/profile/me
// Returns logged-in user's full profile + credit info
router.get('/me', requireAuth, getMyProfile);

// PATCH /api/profile/me
// Update username, company_name, user_type
router.patch('/me', requireAuth, updateMyProfile);

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC - view profile by username
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/profile/:username
// Public profile view (limited fields)
router.get('/:username', getProfileByUsername);

export default router;