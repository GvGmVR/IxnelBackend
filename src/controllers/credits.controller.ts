import { Request, Response } from 'express';

export const getCreditBalance       = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'getCreditBalance - not implemented' });

export const getCreditTransactions  = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'getCreditTransactions - not implemented' });

export const getCreditTransactionById = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'getCreditTransactionById - not implemented' });