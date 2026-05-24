import { Request, Response } from 'express';

export const submitJob    = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'submitJob - not implemented' });

export const getMyJobs    = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'getMyJobs - not implemented' });

export const getJobById   = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'getJobById - not implemented' });

export const getJobStatus = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'getJobStatus - not implemented' });

export const cancelJob    = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'cancelJob - not implemented' });