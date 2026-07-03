// src/controllers/external.controller.ts
import { Request, Response } from 'express';
import { pool } from '../config/db';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { activeProcesses } from '../utils/processManager'; //   Import the shared register

const AdmZip = require('adm-zip') as any;

// Define local interface to bypass global namespace dependency
interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export const externalController = {
  /**
   * Submits a headless AI processing job.
   * Parses the uploaded frames.zip buffer in memory and partitions them securely.
   * POST /api/v1/external/submit
   */
  submitExternalJob: async (req: Request, res: Response): Promise<void> => {
    console.log('[DEBUG][externalController][submitExternalJob] External Ingestion Triggered!');
    try {
      const { profile_id } = req.user!;
      const { jobCost, modelVersion, priority, jobStrategy } = req.body;

      console.log('[DEBUG][externalController][submitExternalJob] req.body:', {
        jobCost,
        modelVersion,
        priority,
        profile_id
      });

      // 1. Basic validation
      if (!jobCost || !modelVersion) {
        res.status(400).json({ success: false, error: 'jobCost and modelVersion are required.' });
        return;
      }

      const baseCost = parseInt(jobCost as string, 10);
      if (isNaN(baseCost) || baseCost <= 0) {
        res.status(400).json({ success: false, error: 'Job cost must be a positive integer.' });
        return;
      }

      // Self-healing file extraction compatible with both upload.any() and upload.fields()
      const rawFiles = (req as any).files;
      let referenceFile: MulterFile | undefined;
      let frameZipFile: MulterFile | undefined;

      if (Array.isArray(rawFiles)) {
        referenceFile = rawFiles.find(f => f.fieldname === 'reference');
        frameZipFile = rawFiles.find(f => f.fieldname === 'frames');
      } else if (rawFiles && typeof rawFiles === 'object') {
        referenceFile = rawFiles['reference']?.[0];
        frameZipFile = rawFiles['frames']?.[0];
      }

      if (!referenceFile || !frameZipFile) {
        res.status(400).json({ success: false, error: 'Both reference image and frames zip are required.' });
        return;
      }      

      // 2. Load the ZIP file in-memory using adm-zip [1.1.4, 1.2.4]
      const zip = new AdmZip(frameZipFile.buffer);
      
      // Extract, filter, and sanitize the image entries inside the zip
      const zipEntries = zip.getEntries().filter((entry: any) => {
        const name = entry.entryName.toLowerCase();
        return !entry.isDirectory && (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg'));
      });

      // Sort entries alphabetically to maintain perfect sequence order
      zipEntries.sort((a: any, b: any) => a.entryName.localeCompare(b.entryName));

      // 2. Sliding Window Partitioning Math (Capped or Single-Pass routing) [1.2.4]
      const N = zipEntries.length;
      if (N === 0) {
        res.status(400).json({ success: false, error: 'No valid lineart frames found inside the uploaded ZIP.' });
        return;
      }

      console.log(`[externalController][submitExternalJob] Parsed ZIP sequence. Found ${N} valid frames.`);
      const chunks: { start: number; end: number }[] = [];

      if (jobStrategy === 'single' || N <= 24) {
        // ⚠️ SINGLE PASS: Process the entire sequence as a single job chunk [1.2.4]
        chunks.push({ start: 0, end: N - 1 });
      } else {
        // SLIDING WINDOW: Split into 24-frame overlapping segments
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
      const totalCost = K * baseCost; // Total cost scales by number of separate chunks to queue

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // 4. Lock profile for balance validation (Aligned with active current_credit_balance column)
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

        // Dynamic client type resolution: Reads from the incoming payload, defaults to 'external' if omitted [1.2.4]
        const clientType = req.body.clientType || 'external';

        // 5. Generate Directories and Queue DB Records for each Chunk
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

          // Extract chunk-specific files from the memory ZIP and map their original names [1.2.4]
          const mappingObj: Record<string, string> = {};
          
          for (let i = chunk.start; i <= chunk.end; i++) {
            const entry = zipEntries[i];
            const paddedIndex = String(i - chunk.start + 1).padStart(4, '0');
            const frameExt = path.extname(entry.entryName) || '.png';
            const paddedName = `frame_${paddedIndex}${frameExt}`;
            
            // Extract file buffer from memory and write natively to disk [1.2.4]
            const fileBuffer = entry.getData();
            await fs.writeFile(path.join(framesDir, paddedName), fileBuffer);

            // Map the padded sequence name back to the user's uploaded filename inside the zip
            mappingObj[paddedName] = path.basename(entry.entryName);
          }

          // Write mapping metadata directly into the job's temporary workspace directory [1.2.4]
          await fs.writeFile(
            path.join(jobDir, 'frame_mapping.json'),
            JSON.stringify(mappingObj, null, 2)
          );

          runningReservedCredits += baseCost;

          // Insert Job Record (Explicitly tagged with clientType to isolate workspaces)
          const jobQuery = `
            INSERT INTO jobs (id, profile_id, input_path, status, job_cost, model_version, priority, client_type)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, profile_id, input_path, status, job_cost, model_version, priority, created_at;
          `;
          const jobResult = await client.query(jobQuery, [
            jobId,
            profile_id as string,
            jobDir,
            'queued',
            baseCost,
            modelVersion as string,
            priority || 0,
            clientType
          ]);
        
          queuedJobs.push(jobResult.rows[0]);

          // Write Ledger Transaction (with 6 explicit placeholders)
          const newAvailableBalance = current_credit_balance - runningReservedCredits;
          await client.query(
            `INSERT INTO credit_transactions (profile_id, transaction_type, amount, balance_after, reference_job_id, notes)
             VALUES ($1, $2, $3, $4, $5, $6);`,
            [
              profile_id as string, // $1
              'reservation',        // $2 (transaction_type)
              -baseCost,            // $3 (amount)
              newAvailableBalance,  // $4 (balance_after)
              jobId,                // $5 (reference_job_id)
              `Reserved ${baseCost} credits for external job chunk ${idx + 1}/${K}` // $6 (notes)
            ]
          );
        }

        // 6. Save final reservation count
        await client.query(
          `UPDATE profiles SET reserved_credits = $1 WHERE id = $2;`,
          [runningReservedCredits, profile_id as string]
        );

        await client.query('COMMIT');

        const newJob = queuedJobs[0];

        // 7. Return response containing both the primary job ID and the full batch array
        res.status(201).json({
          success: true,
          id: newJob.id,
          status: newJob.status,
          input_path: newJob.input_path,
          job_cost: newJob.job_cost,
          model_version: newJob.model_version,
          priority: newJob.priority,
          created_at: newJob.created_at,
          batchJobIds: queuedJobs.map((j) => j.id), // Expose batch array so external client can track all chunks
          message: 'Jobs successfully queued.'
        });
        
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('[externalController][submitExternalJob] Transaction rolled back. Error:', error);
        res.status(500).json({ success: false, error: 'Internal server error submitting external job.' });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('[externalController][submitExternalJob] Connection error:', error);
      res.status(500).json({ success: false, error: 'Internal server error.' });
    }
  },

  /**
   * Retrieves status and processing state of a specific job.
   * GET /api/v1/external/jobs/:id/status
   */
  getExternalJobStatus: async (req: Request, res: Response): Promise<void> => {
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

      // Flattened response structure so third-party clients can read properties directly
      res.status(200).json({
        success: true,
        id: job.id,
        status: job.status,
        processing_time_ms: job.processing_time_ms,
        error_message: job.error_message,
        output_path: job.output_path
      });
      
    } catch (error) {
      console.error('[externalController][getExternalJobStatus] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve job status.' });
    }
  },

/**
   * Cancels a queued or active processing job externally.
   * Kills running threads and enforces credit deductions on active jobs.
   * PATCH /api/v1/external/jobs/:id/cancel
   */
  cancelExternalJob: async (req: Request, res: Response): Promise<void> => {
    const { profile_id } = req.user!;
    const jobId = req.params.id as string;

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Fetch job with lock to prevent concurrency issues
      const jobResult = await client.query(
        `SELECT id, status, job_cost FROM jobs WHERE id = $1 AND profile_id = $2 FOR UPDATE;`,
        [jobId, profile_id as string]
      );

      if (jobResult.rowCount === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ success: false, error: 'Job not found.' });
        return;
      }

      const job = jobResult.rows[0];

      // Block cancellation of already completed/failed/cancelled jobs
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: `Cannot cancel a job with status '${job.status}'.` });
        return;
      }

      // 2. Update job status to 'cancelled' in database
      // 2. Update job status to 'cancelled' in database
      await client.query(
        `UPDATE jobs SET status = 'cancelled', completed_at = NOW() WHERE id = $1;`,
        [jobId]
      );

      // ⚠️ MODIFICATION: Resolve physical process existence to check compute footprint before assessing refunds
      const proc = activeProcesses.get(jobId);
      
      // Eligible for a full refund if queued, or if initiated but process execution had not physically started
      const isEligibleForRefund = job.status === 'queued' || (job.status === 'initiated' && !proc);

      // 3. Process cancellation logic based on verified physical compute footprint
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

          console.log(`[cancelExternalJob] Released ${job.job_cost} reserved credits for profile ${profile_id}`);
        }
      } 
      else {
        // SCENARIO B: Enforce credit deduction (No Refund) due to active GPU node usage
        console.log(`[cancelExternalJob] Active cancellation requested for running job: ${jobId}`);
        
        // Locate and terminate the spawned OS child process in real-time
        if (proc) {
          proc.kill('SIGTERM'); // Send standard termination signal
          activeProcesses.delete(jobId);
          console.log(`[cancelExternalJob] Successfully terminated active Python process for job: ${jobId}`);
        }

        // Deduct credits permanently since they consumed GPU compute resources
        // ⚠️ MODIFICATION: Select subscription_credits and purchased_credits to prevent FIFO column drift
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

          // ⚠️ MODIFICATION: Implement identical FIFO deduction to align with colorization_worker.ts
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

          // ⚠️ MODIFICATION: Synchronize all columns to keep database balance structure coherent
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

          // Record permanent deduction ledger entry
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

          console.log(`[cancelExternalJob] Permanently deducted ${job.job_cost} credits for active job cancellation: ${jobId}`);
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
      console.error('[externalController][cancelExternalJob] Error cancelling job:', error);
      res.status(500).json({ success: false, error: 'Internal server error cancelling job.' });
    } finally {
      client.release();
    }
  },

  /**
   * Retrieves the live credit balance for the authenticated API Key.
   * GET /api/v1/external/balance
   */
  getExternalBalance: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      
      const query = `
        SELECT current_credit_balance, reserved_credits 
        FROM profiles 
        WHERE id = $1;
      `;
      const result = await pool.query(query, [profile_id as string]);

      if (result.rowCount === 0) {
        res.status(404).json({ success: false, error: 'User profile not found.' });
        return;
      }

      const { current_credit_balance, reserved_credits } = result.rows[0];
      const available_credits = current_credit_balance - reserved_credits;

      res.status(200).json({
        success: true,
        total_credits: current_credit_balance,
        reserved_credits: reserved_credits,
        available_credits: available_credits
      });
    } catch (error) {
      console.error('[externalController][getExternalBalance] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve balance.' });
    }
  },
  
  /**
   * Retrieves all jobs belonging to the authenticated profile, filtered dynamically by client type.
   * GET /api/v1/external/jobs?clientType=after_effects
   */
  getMyJobs: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      
      // Reads from query string, defaults to 'external'
      const clientType = req.query.clientType as string || 'external';
      
      const query = `
        SELECT id, input_path, output_path, status, job_cost, model_version, priority, processing_time_ms, error_message, created_at, started_at, completed_at
        FROM jobs
        WHERE profile_id = $1 AND client_type = $2
        ORDER BY created_at DESC;
      `;
      const result = await pool.query(query, [profile_id as string, clientType]);
      
      res.status(200).json({ 
        success: true, 
        jobs: result.rows 
      });
    } catch (error) {
      console.error('[externalController][getMyJobs] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve jobs history.' });
    }
  },

   // ⚠️ MODIFICATION: Clean workspace mechanism to delete failed or cancelled job folders and database records
  clearUnsuccessfulJobs: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      const clientType = req.query.clientType as string || 'external';

      // 1. Fetch directories of failed/cancelled jobs for the profile to prevent orphaned files
      const selectQuery = `
        SELECT id, input_path 
        FROM jobs 
        WHERE profile_id = $1 AND status IN ('failed', 'cancelled') AND client_type = $2;
      `;
      const result = await pool.query(selectQuery, [profile_id as string, clientType]);
      const jobsToClear = result.rows;

      // 2. Perform direct disk cleanup on server workspace
      for (const job of jobsToClear) {
        if (job.input_path) {
          try {
            await fs.rm(job.input_path, { recursive: true, force: true });
            console.log(`[externalController] Disk workspace purged for cleared job: ${job.input_path}`);
          } catch (rmErr) {
            console.warn(`[externalController] Transient cleanup warning for path ${job.input_path}:`, rmErr);
          }
        }
      }

      // 3. Delete matching rows from database
      const deleteQuery = `
        DELETE FROM jobs 
        WHERE profile_id = $1 AND status IN ('failed', 'cancelled') AND client_type = $2;
      `;
      const deleteResult = await pool.query(deleteQuery, [profile_id as string, clientType]);

      res.status(200).json({
        success: true,
        message: `Successfully cleared ${deleteResult.rowCount} jobs from your history.`
      });

    } catch (error) {
      console.error('[externalController][clearUnsuccessfulJobs] Error:', error);
      res.status(500).json({ success: false, error: 'Internal server error while clearing history records.' });
    }
  },

  /**
 * Permanently deletes a single job record and its disk workspace.
 * Only completed, failed, or cancelled jobs can be deleted this way.
 * DELETE /api/v1/external/jobs/:id
 */
deleteExternalJob: async (req: Request, res: Response): Promise<void> => {
    const { profile_id } = req.user!;
    const jobId = req.params.id as string;

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Fetch job with ownership check and lock
        const jobResult = await client.query(
            `SELECT id, status, input_path, job_cost FROM jobs 
             WHERE id = $1 AND profile_id = $2 FOR UPDATE;`,
            [jobId, profile_id as string]
        );

        if (jobResult.rowCount === 0) {
            await client.query('ROLLBACK');
            res.status(404).json({ success: false, error: 'Job not found.' });
            return;
        }

        const job = jobResult.rows[0];

        // Block deletion of jobs that are still active — must cancel first
        if (['queued', 'initiated', 'processing'].includes(job.status)) {
            await client.query('ROLLBACK');
            res.status(400).json({
                success: false,
                error: `Cannot delete an active job with status '${job.status}'. Please cancel it first.`
            });
            return;
        }

        // Clean up disk workspace
        if (job.input_path) {
            try {
                await fs.rm(job.input_path, { recursive: true, force: true });
                console.log(`[deleteExternalJob] Disk workspace purged: ${job.input_path}`);
            } catch (rmErr) {
                console.warn(`[deleteExternalJob] Disk cleanup warning for ${job.input_path}:`, rmErr);
                // Non-fatal — continue with DB deletion
            }
        }

        // Delete the job record
        await client.query(
            `DELETE FROM jobs WHERE id = $1 AND profile_id = $2;`,
            [jobId, profile_id as string]
        );

        await client.query('COMMIT');

        res.status(200).json({
            success: true,
            message: `Job ${jobId} permanently deleted.`
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[externalController][deleteExternalJob] Error:', error);
        res.status(500).json({ success: false, error: 'Internal server error deleting job.' });
    } finally {
        client.release();
    }
},
};