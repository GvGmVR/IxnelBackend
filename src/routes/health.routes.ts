import { Router, Request, Response } from 'express';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/health
// Public - basic alive check
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    success   : true,
    message   : 'IXNEL API is running',
    timestamp : new Date().toISOString(),
    env       : process.env.NODE_ENV || 'development',
  });
});

export default router;