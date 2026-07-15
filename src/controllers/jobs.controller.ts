// src/controllers/jobs.controller.ts
import { Request, Response } from 'express';
import { pool } from '../config/db';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export const jobsController = {
  /**
   * Submits an AI processing job.
   * Enforces a maximum of 5 active/queued jobs per project at a time [1].
   * POST /api/jobs/submit
   */
  submitJob: async (req: Request, res: Response): Promise<void> => {
    console.log('[DEBUG][jobsController][submitJob] Ingestion Request Triggered!');
    try {
      const { profile_id } = req.user!;
      const { projectId, jobCost, modelVersion, priority, startFrame, endFrame } = req.body;

      if (!projectId || !jobCost || !modelVersion) {
        res.status(400).json({ success: false, error: 'projectId, jobCost, and modelVersion are required.' });
        return;
      }

      const baseCost = parseInt(jobCost as string, 10);
      if (isNaN(baseCost) || baseCost <= 0) {
        res.status(400).json({ success: false, error: 'Job cost must be a positive integer.' });
        return;
      }

      const pId = projectId as string;
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // 1. Verify project ownership
        const projectCheck = await client.query(
          `SELECT id FROM projects WHERE id = $1 AND profile_id = $2;`,
          [pId, profile_id as string]
        );

        if (projectCheck.rowCount === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({ success: false, error: 'Target project not found.' });
          return;
        }

        // 2. ENFORCE RESOURCE QUOTA: Max 5 active/queued jobs per project [1]
        const activeJobsCheck = await client.query(
          `SELECT COUNT(*) FROM jobs WHERE project_id = $1 AND status IN ('queued', 'initiated', 'processing');`,
          [pId]
        );
        const activeCount = parseInt(activeJobsCheck.rows[0].count, 10);

        // Self-healing file extraction compatible with flat and nested formats
        const rawFiles = (req as any).files;
        let referenceFile: MulterFile | undefined;
        let frameFiles: MulterFile[] = [];

        if (Array.isArray(rawFiles)) {
          referenceFile = rawFiles.find(f => f.fieldname === 'reference');
          frameFiles = rawFiles.filter(f => f.fieldname === 'frames');
        } else if (rawFiles && typeof rawFiles === 'object') {
          referenceFile = rawFiles['reference']?.[0];
          frameFiles = rawFiles['frames'] || [];
        }

        if (!referenceFile || frameFiles.length === 0) {
          await client.query('ROLLBACK');
          res.status(400).json({ success: false, error: 'Both a reference image and line_art frames are required.' });
          return;
        }

        // Sliding Window Partitioning Math (Max 24-frame chunks)
        const N = frameFiles.length;
        const chunks: { start: number; end: number }[] = [];

        if (N <= 24) {
          chunks.push({ start: 0, end: N - 1 });
        } else {
          let start = 0;
          while (start + 24 <= N) {
            chunks.push({ start, end: start + 23 });
            start += 24;
          }
          if (chunks[chunks.length - 1].end < N - 1) {
            chunks.push({ start: N - 24, end: N - 1 });
          }
        }

        const K = chunks.length;

        // Block submission if incoming chunks exceed the active queue limit [1]
        if (activeCount + K > 5) {
          await client.query('ROLLBACK');
          res.status(400).json({
            success: false,
            error: `Queue quota exceeded. You can have a maximum of 5 active/queued jobs per project. Currently active: ${activeCount}. This batch would add ${K} jobs.`
          });
          return;
        }

        const totalCost = K * baseCost;

        // 3. Lock profile for balance validation
        const profileResult = await client.query(
          `SELECT current_credit_balance, reserved_credits FROM profiles WHERE id = $1 FOR UPDATE;`,
          [profile_id as string]
        );

        if (profileResult.rowCount === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({ success: false, error: 'User profile not found.' });
          return;
        }

        const { current_credit_balance, reserved_credits } = profileResult.rows[0];
        const availableCredits = current_credit_balance - reserved_credits;

        if (availableCredits < totalCost) {
          await client.query('ROLLBACK');
          res.status(402).json({
            success: false,
            error: `Insufficient balance. Batch rendering requires ${totalCost} credits, but you only have ${availableCredits} available.`
          });
          return;
        }

        const queuedJobs: any[] = [];
        let runningReservedCredits = reserved_credits;

        const startFrameBase = parseInt(startFrame as string, 10) || 1;

        // 4. Generate Directories and Queue DB Records for each Chunk
        for (let idx = 0; idx < K; idx++) {
          const chunk = chunks[idx];
          const jobId = crypto.randomUUID();
          const jobDir = path.join(process.cwd(), 'temp', 'jobs', jobId);
          const framesDir = path.join(jobDir, 'frames');

          await fs.mkdir(framesDir, { recursive: true });

          // Save reference sheet
          const refExt = path.extname(referenceFile.originalname) || '.png';
          const refPath = path.join(jobDir, `reference${refExt}`);
          await fs.writeFile(refPath, referenceFile.buffer);

          const mappingObj: Record<string, string> = {};
          
          for (let i = chunk.start; i <= chunk.end; i++) {
            const file = frameFiles[i];
            const paddedIndex = String(i - chunk.start + 1).padStart(4, '0');
            const frameExt = path.extname(file.originalname) || '.png';
            
            const paddedName = `frame_${paddedIndex}${frameExt}`;
            const framePath = path.join(framesDir, paddedName);
            await fs.writeFile(framePath, file.buffer);

            mappingObj[paddedName] = file.originalname;
          }

          await fs.writeFile(
            path.join(jobDir, 'frame_mapping.json'),
            JSON.stringify(mappingObj, null, 2)
          );

          runningReservedCredits += baseCost;

          // Calculate absolute frame indices for DB logging [1]
          const chunkStartFrame = startFrameBase + chunk.start;
          const chunkEndFrame = startFrameBase + chunk.end;

          // Insert Job Record (with project_id, start_frame, and end_frame) [1]
          const jobQuery = `
            INSERT INTO jobs (id, profile_id, project_id, input_path, status, job_cost, model_version, priority, client_type, start_frame, end_frame)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id, profile_id, project_id, input_path, status, job_cost, model_version, priority, created_at;
          `;
          const jobResult = await client.query(jobQuery, [
            jobId,
            profile_id as string,
            pId,
            jobDir,
            'queued', 
            baseCost, 
            modelVersion as string, 
            priority || 0,
            'web',
            chunkStartFrame,
            chunkEndFrame
          ]);

          queuedJobs.push(jobResult.rows[0]);

          // Write Ledger Transaction
          const newAvailableBalance = current_credit_balance - runningReservedCredits;
          await client.query(
            `INSERT INTO credit_transactions (profile_id, transaction_type, amount, balance_after, reference_job_id, notes)
             VALUES ($1, $2, $3, $4, $5, $6);`,
            [
              profile_id as string,
              'reservation',       
              -baseCost,           
              newAvailableBalance, 
              jobId,               
              `Reserved ${baseCost} credits for job chunk ${idx + 1}/${K}`
            ]
          );
        }

        // 5. Save final reservation count
        await client.query(
          `UPDATE profiles SET reserved_credits = $1 WHERE id = $2;`,
          [runningReservedCredits, profile_id as string]
        );

        await client.query('COMMIT');

        const newJob = queuedJobs[0];

        res.status(201).json({
          success: true,
          id: newJob.id,
          status: newJob.status,
          input_path: newJob.input_path,
          job_cost: newJob.job_cost,
          model_version: newJob.model_version,
          priority: newJob.priority,
          created_at: newJob.created_at,
          batchJobIds: queuedJobs.map((j) => j.id),
          message: 'Jobs successfully queued.'
        });
        
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('[jobsController][submitJob] Transaction rolled back. Error:', error);
        res.status(500).json({ success: false, error: 'Internal server error submitting job.' });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('[jobsController][submitJob] Connection error:', error);
      res.status(500).json({ success: false, error: 'Internal server error.' });
    }
  },

  /**
   * Retrieves all jobs belonging to the authenticated user.
   */
  getMyJobs: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      const projectId = req.query.projectId as string; // Optional filtering param [1]
      
      let query = `
        SELECT id, input_path, output_path, status, job_cost, model_version, priority, processing_time_ms, error_message, created_at, started_at, completed_at, start_frame, end_frame
        FROM jobs
        WHERE profile_id = $1
      `;
      const queryParams: any[] = [profile_id as string];

      if (projectId) {
        query += ` AND project_id = $2`;
        queryParams.push(projectId);
      }

      query += ` ORDER BY created_at DESC;`;
      const result = await pool.query(query, queryParams);
      
      res.status(200).json({ success: true, jobs: result.rows });
    } catch (error) {
      console.error('[jobsController][getMyJobs] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve jobs.' });
    }
  },

  /**
   * Retrieves a specific job by ID.
   */
  getJobById: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      const jobId = req.params.id as string;
      const query = `
        SELECT id, input_path, output_path, status, job_cost, model_version, priority, processing_time_ms, error_message, created_at, started_at, completed_at, start_frame, end_frame
        FROM jobs
        WHERE id = $1 AND profile_id = $2;
      `;
      const result = await pool.query(query, [jobId, profile_id as string]);

      if (result.rowCount === 0) {
        res.status(404).json({ success: false, error: 'Job not found.' });
        return;
      }
      res.status(200).json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error('[jobsController][getJobById] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve job.' });
    }
  },

  /**
   * Retrieves status and processing state of a specific job.
   */
  getJobStatus: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      const jobId = req.params.id as string;
      const query = `
        SELECT id, status, processing_time_ms, error_message, output_path
        FROM jobs
        WHERE id = $1 AND profile_id = $2;
      `;
      const result = await pool.query(query, [jobId, profile_id as string]);

      if (result.rowCount === 0) {
        res.status(404).json({ success: false, error: 'Job not found.' });
        return;
      }

      const job = result.rows[0];

      res.status(200).json({
        success: true,
        id: job.id,
        status: job.status,
        processing_time_ms: job.processing_time_ms,
        error_message: job.error_message,
        output_path: job.output_path
      });
      
    } catch (error) {
      console.error('[jobsController][getJobStatus] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve job status.' });
    }
  },

  /**
   * Cancels a queued or active processing job.
   */
  cancelJob: async (req: Request, res: Response): Promise<void> => {
    const { profile_id } = req.user!;
    const jobId = req.params.id as string;

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const jobResult = await client.query(
        `SELECT id, status, job_cost, runpod_job_id FROM jobs WHERE id = $1 AND profile_id = $2 FOR UPDATE;`,
        [jobId, profile_id as string]
      );

      if (jobResult.rowCount === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ success: false, error: 'Job not found.' });
        return;
      }

      const job = jobResult.rows[0];

      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: `Cannot cancel a job with status '${job.status}'.` });
        return;
      }

      await client.query(
        `UPDATE jobs SET status = 'cancelled', completed_at = NOW() WHERE id = $1;`,
        [jobId]
      );

      const runpodJobId = job.runpod_job_id;
      const runpodApiKey = process.env.RUNPOD_API_KEY;
      const runpodEndpointId = process.env.RUNPOD_ENDPOINT_ID;

      if (runpodJobId && runpodApiKey && runpodEndpointId) {
        try {
          const cancelUrl = `https://api.runpod.ai/v2/${runpodEndpointId}/cancel/${runpodJobId}`;
          const cancelRes = await fetch(cancelUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${runpodApiKey}`,
              'Content-Type': 'application/json'
            }
          });
          if (cancelRes.ok) {
            console.log(`[cancelJob] Successfully cancelled RunPod job ${runpodJobId} on cloud.`);
          } else {
            console.warn(`[cancelJob] RunPod cancellation returned status: ${cancelRes.status}`);
          }
        } catch (err: any) {
          console.error(`[cancelJob] RunPod cancel request failed:`, err.message);
        }
      }

      const isEligibleForRefund = job.status === 'queued';

      if (isEligibleForRefund) {
        // SCENARIO A: Release locked credits hold (Refund)
        const profileResult = await client.query(
          `SELECT current_credit_balance, reserved_credits FROM profiles WHERE id = $1 FOR UPDATE;`,
          [profile_id as string]
        );
        
        if (profileResult.rowCount !== null && profileResult.rowCount > 0) {
          const { current_credit_balance, reserved_credits } = profileResult.rows[0];
          const newReserved = Math.max(0, reserved_credits - job.job_cost);

          await client.query(
            `UPDATE profiles SET reserved_credits = $1 WHERE id = $2;`,
            [newReserved, profile_id as string]
          );

          const newAvailableBalance = current_credit_balance - newReserved;
          await client.query(
            `INSERT INTO credit_transactions (profile_id, transaction_type, amount, balance_after, reference_job_id, notes)
             VALUES ($1, $2, $3, $4, $5, $6);`,
            [
              profile_id as string,
              'reservation_release',
              job.job_cost,
              newAvailableBalance,
              jobId,
              `Released ${job.job_cost} reserved credits due to job cancellation`
            ]
          );

          console.log(`[cancelJob] Released ${job.job_cost} reserved credits for profile ${profile_id}`);
        }
      } else {
        // SCENARIO B: Enforce credit deduction (No Refund) due to active GPU node usage
        console.log(`[cancelJob] Active cancellation requested for running job: ${jobId}`);

        const profileResult = await client.query(
          `SELECT current_credit_balance, reserved_credits, subscription_credits, purchased_credits, total_credits_used 
           FROM profiles 
           WHERE id = $1 FOR UPDATE;`,
          [profile_id as string]
        );

        if (profileResult.rowCount !== null && profileResult.rowCount > 0) {
          const { 
            current_credit_balance, 
            reserved_credits, 
            subscription_credits, 
            purchased_credits, 
            total_credits_used 
          } = profileResult.rows[0];
          
          let remainingCost = job.job_cost;
          let newSubscriptionCredits = subscription_credits || 0;
          let newPurchasedCredits = purchased_credits || 0;

          if (newSubscriptionCredits >= remainingCost) {
            newSubscriptionCredits -= remainingCost;
            remainingCost = 0;
          } else {
            remainingCost -= newSubscriptionCredits;
            newSubscriptionCredits = 0;
          }

          if (remainingCost > 0) {
            newPurchasedCredits = Math.max(0, newPurchasedCredits - remainingCost);
          }

          const newCredits = newSubscriptionCredits + newPurchasedCredits;
          const newReserved = Math.max(0, reserved_credits - job.job_cost);
          const newTotalUsed = (total_credits_used || 0) + job.job_cost;

          await client.query(
            `UPDATE profiles 
             SET 
               subscription_credits = $1, 
               purchased_credits = $2, 
               current_credit_balance = $3, 
               reserved_credits = $4, 
               total_credits_used = $5 
             WHERE id = $6;`,
            [newSubscriptionCredits, newPurchasedCredits, newCredits, newReserved, newTotalUsed, profile_id as string]
          );

          const finalAvailableBalance = newCredits - newReserved;
          await client.query(
            `INSERT INTO credit_transactions (profile_id, transaction_type, amount, balance_after, reference_job_id, notes)
             VALUES ($1, $2, $3, $4, $5, $6);`,
            [
              profile_id as string,
              'job_deduction',
              -job.job_cost,
              finalAvailableBalance,
              jobId,
              `Permanently deducted ${job.job_cost} credits for cancelled active rendering execution`
            ]
          );

          console.log(`[cancelJob] Permanently deducted ${job.job_cost} credits for active job cancellation: ${jobId}`);
        }
      }

      await client.query('COMMIT');

      res.status(200).json({
        success: true,
        message: job.status === 'queued'
          ? 'Job successfully cancelled. Reserved credits have been returned to your available balance.'
          : 'Active job successfully terminated. Spent credits have been deducted.'
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[jobsController][cancelJob] Error cancelling job:', error);
      res.status(500).json({ success: false, error: 'Internal server error cancelling job.' });
    } finally {
      client.release();
    }
  }
};