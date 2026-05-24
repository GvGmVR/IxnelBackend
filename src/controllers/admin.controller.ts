import { Request, Response } from 'express';

export const getAllUsers    = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'getAllUsers - not implemented' });

export const getUserById   = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'getUserById - not implemented' });

export const blockUser     = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'blockUser - not implemented' });

export const unblockUser   = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'unblockUser - not implemented' });

export const adjustCredits = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'adjustCredits - not implemented' });

export const getAllJobs     = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'getAllJobs - not implemented' });

export const getAllPayments = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'getAllPayments - not implemented' });