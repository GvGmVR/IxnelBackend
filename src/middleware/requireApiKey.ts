// src/middleware/requireApiKey.ts
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from '../config/db';

export const requireApiKey = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    let apiKey = req.headers['x-api-key'] as string | undefined;

    // Extract Bearer token if provided
    if (authHeader && authHeader.startsWith('Bearer ')) {
      apiKey = authHeader.split(' ')[1];
    }

    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      res.status(401).json({ success: false, error: 'Authentication required. Missing API Key.' });
      return;
    }

    // 1. Hash the incoming API key to compare against database hashes
    const keyHash = crypto.createHash('sha256').update(apiKey.trim()).digest('hex');

    // 2. Fetch the active key along with profile credentials
    const query = `
      SELECT k.id, k.profile_id, k.is_active, p.auth_user_id
      FROM api_keys k
      JOIN profiles p ON k.profile_id = p.id
      WHERE k.key_hash = $1;
    `;
    const result = await pool.query(query, [keyHash]);

    if (result.rowCount === 0) {
      res.status(401).json({ success: false, error: 'Invalid API key.' });
      return;
    }

    const keyRecord = result.rows[0];

    if (!keyRecord.is_active) {
      res.status(403).json({ success: false, error: 'API key has been deactivated.' });
      return;
    }

    // 3. Fetch user email to cleanly match standard JwtPayload shape
    const userQuery = `SELECT email FROM auth_users WHERE id = $1;`;
    const userResult = await pool.query(userQuery, [keyRecord.auth_user_id]);
    const email = userResult.rows[0]?.email || '';

    // 4. Mock the req.user object so your downstream controllers work seamlessly
    req.user = {
      auth_user_id: keyRecord.auth_user_id,
      profile_id: keyRecord.profile_id,
      email: email
    };

    // 5. Update last_used_at timestamp asynchronously (non-blocking)
    pool.query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1;`, [keyRecord.id]).catch(err => {
      console.error('[requireApiKey] Failed to update last_used_at:', err);
    });

    next();
  } catch (error) {
    console.error('[requireApiKey] Middleware error:', error);
    res.status(500).json({ success: false, error: 'Internal server error during API authentication.' });
  }
};