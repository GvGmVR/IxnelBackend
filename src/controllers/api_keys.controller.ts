// src/controllers/api_keys.controller.ts
import { Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../config/db';

export const apiKeysController = {
  /**
   * Retrieves all API keys belonging to the authenticated profile.
   * GET /api/credits/keys (or mapped route)
   */
  listApiKeys: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;

      const query = `
        SELECT id, key_name, key_prefix, last_used_at, is_active, created_at
        FROM api_keys
        WHERE profile_id = $1
        ORDER BY created_at DESC;
      `;
      const result = await pool.query(query, [profile_id as string]);

      res.status(200).json({
        success: true,
        keys: result.rows
      });
    } catch (error) {
      console.error('[apiKeysController][listApiKeys] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve API keys.' });
    }
  },

  /**
   * Generates a new cryptographically secure API key, hashes it, and stores it.
   * Returns the raw key to the client ONLY ONCE [2].
   * POST /api/credits/keys
   */
  createApiKey: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      const { keyName } = req.body;

      if (!keyName || typeof keyName !== 'string' || !keyName.trim()) {
        res.status(400).json({ success: false, error: 'keyName is required.' });
        return;
      }

      // 1. Generate secure random token
      const rawToken = 'ixnel_sk_' + crypto.randomBytes(24).toString('hex');
      
      // 2. Hash the raw token for secure storage lookup (SHA-256)
      const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

      // 3. Create a masked prefix representation for the UI (e.g., ixnel_sk_abcd...wXyZ)
      const prefix = rawToken.substring(0, 13) + '...' + rawToken.substring(rawToken.length - 4);

      const query = `
        INSERT INTO api_keys (profile_id, key_name, key_hash, key_prefix)
        VALUES ($1, $2, $3, $4)
        RETURNING id, key_name, key_prefix, is_active, created_at;
      `;
      const result = await pool.query(query, [
        profile_id as string,
        keyName.trim(),
        hashedToken,
        prefix
      ]);

      const newKeyRecord = result.rows[0];

      // ⚠️ SECURITY: Send the raw token back to the frontend ONLY ONCE [2]
      res.status(201).json({
        success: true,
        key: {
          ...newKeyRecord,
          raw_key: rawToken // This is the ONLY time this value is ever exposed
        },
        message: 'API Key generated successfully. Please copy it now as it will not be displayed again.'
      });

    } catch (error) {
      console.error('[apiKeysController][createApiKey] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to generate API key.' });
    }
  },

  /**
   * Revokes (permanently deletes) an existing API key.
   * DELETE /api/credits/keys/:id
   */
  revokeApiKey: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      const keyId = req.params.id as string;

      const query = `
        DELETE FROM api_keys
        WHERE id = $1 AND profile_id = $2
        RETURNING id;
      `;
      const result = await pool.query(query, [keyId, profile_id as string]);

      if (result.rowCount === 0) {
        res.status(404).json({ success: false, error: 'API key not found or unauthorized.' });
        return;
      }

      res.status(200).json({
        success: true,
        message: 'API key revoked successfully.'
      });
    } catch (error) {
      console.error('[apiKeysController][revokeApiKey] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to revoke API key.' });
    }
  }
};