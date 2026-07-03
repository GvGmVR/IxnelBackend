// server/src/middleware/requireCepClient.ts

import { Request, Response, NextFunction } from 'express';

/**
 * CSRF Defense Layer: Validates that requests originate from the CEP panel.
 * Browser-based CSRF attacks cannot set custom headers cross-origin (blocked by CORS preflight).
 * The CEP plugin always sends this header; a browser CSRF attempt cannot.
 */
export const requireCepClient = (req: Request, res: Response, next: NextFunction) => {
    const clientMarker = req.headers['x-ixnel-client'];
    
    if (!clientMarker || clientMarker !== 'cep-panel') {
        return res.status(403).json({ 
            success: false, 
            error: 'Invalid client origin.' 
        });
    }
    
    next();
};