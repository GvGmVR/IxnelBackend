import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JwtPayload }   from '../lib/jwt';

// ─────────────────────────────────────────────────────────────────────────────
// Extend Express Request to carry decoded user
// ─────────────────────────────────────────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export const requireAuth = (
  req      : Request,
  res      : Response,
  next     : NextFunction
): void => {
  try {
    // ── Extract Bearer token ─────────────────────────────────────────────
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success : false,
        error   : 'Authorization token required',
      });
      return;
    }

    const token   = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);

    // ── Attach decoded payload to request ────────────────────────────────
    req.user = decoded;
    next();

  } catch (error) {
    res.status(401).json({
      success : false,
      error   : 'Invalid or expired token. Please login again.',
    });
  }
};