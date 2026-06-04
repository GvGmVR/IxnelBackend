// src/services/storage.service.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { pool } from '../config/db';

const bucketName = process.env.STORAGE_BUCKET_NAME || '';
const endpoint = process.env.STORAGE_ENDPOINT || '';
const accessKeyId = process.env.STORAGE_ACCESS_KEY || '';
const secretAccessKey = process.env.STORAGE_SECRET_KEY || '';

// Initialize S3-compatible Cloudflare R2 Client [1.2.4]
const s3Client = new S3Client({
  region: 'auto', // R2 requires region to be 'auto'
  endpoint,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

// Tiered storage allocation rules (in bytes) [1.2.4]
const STORAGE_TIER_LIMITS: Record<string, number> = {
  free: 500 * 1024 * 1024, // 500 MB [1.2.4]
  [process.env.PADDLE_PRICE_ID_PRO_MONTHLY || 'pro_monthly']: 10 * 1024 * 1024 * 1024, // 10 GB [1.2.4]
  [process.env.PADDLE_PRICE_ID_PRO_YEARLY || 'pro_yearly']: 10 * 1024 * 1024 * 1024,   // 10 GB [1.2.4]
};

export const storageService = {
  /**
   * Calculates the user's current cloud storage usage in bytes [1.2.4].
   */
  getUserCloudUsage: async (profileId: string): Promise<number> => {
    const query = `
      SELECT COALESCE(SUM(pa.file_size_bytes), 0) as total_used
      FROM project_assets pa
      JOIN projects p ON pa.project_id = p.id
      WHERE p.profile_id = $1 AND p.storage_mode = 'cloud';
    `;
    const result = await pool.query(query, [profileId]);
    return parseInt(result.rows[0].total_used, 10);
  },

  /**
   * Resolves the user's maximum storage limit based on their active subscription plan [1.2.4].
   */
  getUserStorageLimit: async (profileId: string): Promise<number> => {
    const query = `
      SELECT plan_code 
      FROM subscriptions 
      WHERE profile_id = $1 AND subscription_status IN ('active', 'trialing')
      LIMIT 1;
    `;
    const result = await pool.query(query, [profileId]);
    const activeSub = result.rows[0];

    const planCode = activeSub ? activeSub.plan_code : 'free';
    return STORAGE_TIER_LIMITS[planCode] || STORAGE_TIER_LIMITS.free;
  },

  /**
   * Enforces tiered storage checks and generates a temporary presigned upload URL [1.2.4].
   */
  generatePresignedUploadUrl: async (
    profileId: string,
    projectId: string,
    fileName: string,
    contentType: string,
    fileSizeBytes: number,
  ): Promise<{ uploadUrl: string; storageKey: string }> => {
    // 1. Enforce Tiered Storage check [1.2.4]
    const currentUsage = await storageService.getUserCloudUsage(profileId);
    const limit = await storageService.getUserStorageLimit(profileId);

    if (currentUsage + fileSizeBytes > limit) {
      const usedMb = (currentUsage / (1024 * 1024)).toFixed(1);
      const limitMb = (limit / (1024 * 1024)).toFixed(1);
      throw new Error(`Storage limit exceeded. Current usage: ${usedMb}MB / ${limitMb}MB.`);
    }

    // 2. Generate secure, unique object key inside the bucket [1.2.4]
    const cleanFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storageKey = `${profileId}/${projectId}/${Date.now()}_${cleanFileName}`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: storageKey,
      ContentType: contentType,
    });

    // 3. Request a 15-minute temporary signed upload link [1.2.4]
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

    return {
      uploadUrl,
      storageKey,
    };
  }
};