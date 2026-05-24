import { Request, Response, NextFunction } from 'express';

export const requireAdmin = (
  _req: Request,
  res: Response,
  next: NextFunction
): void => {
  // TODO: Check req.user.role === 'admin'
  next(); // temporarily passing through
};