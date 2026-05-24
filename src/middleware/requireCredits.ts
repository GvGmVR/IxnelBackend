import { Request, Response, NextFunction } from 'express';

export const requireCredits = (
  _req: Request,
  res: Response,
  next: NextFunction
): void => {
  // TODO: Check available_credits >= job_cost
  // available_credits = credits - reserved_credits
  next(); // temporarily passing through
};