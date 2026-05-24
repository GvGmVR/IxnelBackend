import { Request, Response } from 'express';

export const getMyProfile        = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'getMyProfile - not implemented' });

export const updateMyProfile     = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'updateMyProfile - not implemented' });

export const getProfileByUsername = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'getProfileByUsername - not implemented' });