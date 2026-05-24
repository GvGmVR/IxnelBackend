import { Request, Response } from 'express';

export const initiatePayment  = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'initiatePayment - not implemented' });

export const verifyPayment    = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'verifyPayment - not implemented' });

export const getMyPayments    = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'getMyPayments - not implemented' });

export const getPaymentById   = (_req: Request, res: Response) =>
  res.status(501).json({ success: false, message: 'getPaymentById - not implemented' });