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

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      res.status(401).json({
        success : false,
        error   : 'Malformed Authorization header. Expected: Bearer <token>',
      });
      return;
    }
    const token = parts[1];
    const decoded = verifyAccessToken(token);

    if (!decoded.auth_user_id || !decoded.profile_id || !decoded.email) {
      console.warn('[requireAuth][payload_incomplete]', {
        hasAuthUserId : !!decoded.auth_user_id,
        hasProfileId  : !!decoded.profile_id,
        hasEmail      : !!decoded.email,
        path          : req.path,
      });
      res.status(401).json({
        success : false,
        error   : 'Token payload is invalid. Please login again.',
      });
      return;
    }

    req.user = decoded;
    next();

  } catch (error) {
  console.warn('[requireAuth][token_verification_failed]', {
    reason : error instanceof Error ? error.message : String(error),
    path   : req.path,
    method : req.method,
  });
  res.status(401).json({
    success : false,
    error   : 'Invalid or expired token. Please login again.',
  });
}
};