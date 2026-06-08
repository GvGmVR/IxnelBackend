// src/controllers/jobs.controller.ts
import { Request, Response } from 'express';
import { pool } from '../config/db';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

// Define a local interface to bypass unreliable global namespace declarations
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
   * Parses multipart files, writes them to disk, reserves credits, and queues the job.
   * POST /api/jobs
   */
submitJob: async (req: Request, res: Response): Promise<void> => {
  console.log('[DEBUG][jobsController][submitJob] Ingestion Request Triggered!');
    try {
      const { profile_id } = req.user!;
      const { projectId, jobCost, modelVersion, priority } = req.body;

      console.log('[DEBUG][jobsController][submitJob] req.body:', {
        projectId,
        jobCost,
        modelVersion,
        priority,
        profile_id
      });

      // 1. Basic validation
      if (!projectId || !jobCost || !modelVersion) {
        res.status(400).json({ success: false, error: 'projectId, jobCost, and modelVersion are required.' });
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
      let frameFiles: MulterFile[] = [];

      if (Array.isArray(rawFiles)) {
        // Case A: req.files is a flat array (populated by upload.any())
        referenceFile = rawFiles.find(f => f.fieldname === 'reference');
        frameFiles = rawFiles.filter(f => f.fieldname === 'frames');
      } else if (rawFiles && typeof rawFiles === 'object') {
        // Case B: req.files is a grouped object (populated by upload.fields() / upload.multipart())
        referenceFile = rawFiles['reference']?.[0];
        frameFiles = rawFiles['frames'] || [];
      }

      console.log('[DEBUG][jobsController][submitJob] Parsed files:', {
        hasReference: !!referenceFile,
        frameFilesCount: frameFiles.length
      });

      if (!referenceFile || frameFiles.length === 0) {
        res.status(400).json({ success: false, error: 'Both a reference image and line_art frames are required.' });
        return;
      }      

      if (!referenceFile || frameFiles.length === 0) {
        res.status(400).json({ success: false, error: 'Both a reference image and line_art frames are required.' });
        return;
      }

      // 2. Sliding Window Partitioning Math (Max 24-frame chunks)
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
        // If there's a gap or dangling frames, create an overlapping final chunk
        if (chunks[chunks.length - 1].end < N - 1) {
          chunks.push({ start: N - 24, end: N - 1 });
        }
      }

      const K = chunks.length;
      const totalCost = K * baseCost; // Total cost scales by number of separate chunks to queue

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const pId = projectId as string;

        // 3. Verify project ownership
        const projectCheck = await client.query(
          `SELECT id FROM projects WHERE id = $1 AND profile_id = $2;`,
          [pId, profile_id as string]
        );

        if (projectCheck.rowCount === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({ success: false, error: 'Target project not found.' });
          return;
        }

        // 4. Lock profile for balance validation
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

          // Save ordered files corresponding to this chunk
          // Save ordered files corresponding to this chunk and generate original name map
          const mappingObj: Record<string, string> = {};
          
          for (let i = chunk.start; i <= chunk.end; i++) {
            const file = frameFiles[i];
            const paddedIndex = String(i - chunk.start + 1).padStart(4, '0');
            const frameExt = path.extname(file.originalname) || '.png';
            
            const paddedName = `frame_${paddedIndex}${frameExt}`;
            const framePath = path.join(framesDir, paddedName);
            await fs.writeFile(framePath, file.buffer);

            // Map the padded sequence name back to your raw uploaded filename
            mappingObj[paddedName] = file.originalname;
          }

          // Write mapping metadata directly into the job's temporary workspace directory
          await fs.writeFile(
            path.join(jobDir, 'frame_mapping.json'),
            JSON.stringify(mappingObj, null, 2)
          );

          runningReservedCredits += baseCost;

          // Insert Job Record
          const jobQuery = `
            INSERT INTO jobs (id, profile_id, input_path, status, job_cost, model_version, priority)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, profile_id, input_path, status, job_cost, model_version, priority, created_at;
          `;
          const jobResult = await client.query(jobQuery, [
            jobId,
            profile_id as string,
            jobDir,
            'queued', // Maps to $4 (status)
            baseCost, // Maps to $5 (job_cost)
            modelVersion as string, // Maps to $6 (model_version)
            priority || 0 // Maps to $7 (priority)
          ]);

          queuedJobs.push(jobResult.rows[0]);

          // Write Ledger Transaction
          const newAvailableBalance = current_credit_balance - runningReservedCredits;
          await client.query(
            `INSERT INTO credit_transactions (profile_id, transaction_type, amount, balance_after, reference_job_id, notes)
             VALUES ($1, $2, $3, $4, $5, $6);`,
            [
              profile_id as string, // Maps to $1
              'reservation',        // Maps to $2 (transaction_type)
              -baseCost,            // Maps to $3 (amount)
              newAvailableBalance,  // Maps to $4 (balance_after)
              jobId,                // Maps to $5 (reference_job_id)
              `Reserved ${baseCost} credits for job chunk ${idx + 1}/${K}` // Maps to $6 (notes)
            ]
          );
        }

        // 6. Save final reservation count
        await client.query(
          `UPDATE profiles SET reserved_credits = $1 WHERE id = $2;`,
          [runningReservedCredits, profile_id as string]
        );

        await client.query('COMMIT');

        // Flattened response structure so api.ts can map properties directly to response.data
        // 1. Declare newJob as the primary job record returned to the client for tracking
        // 1. Declare newJob as the primary job record returned to the client for tracking
        const newJob = queuedJobs[0];

        // 2. Flattened response structure returning both the primary job ID and the full batch array
        res.status(201).json({
          success: true,
          id: newJob.id,
          status: newJob.status,
          input_path: newJob.input_path,
          job_cost: newJob.job_cost,
          model_version: newJob.model_version,
          priority: newJob.priority,
          created_at: newJob.created_at,
          batchJobIds: queuedJobs.map((j) => j.id), // ⚠️ Added: Return all job IDs in this batch
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
      const query = `
        SELECT id, input_path, output_path, status, job_cost, model_version, priority, processing_time_ms, error_message, created_at, started_at, completed_at
        FROM jobs
        WHERE profile_id = $1
        ORDER BY created_at DESC;
      `;
      const result = await pool.query(query, [profile_id as string]);
      
      // Flattened list structure bypassing client double-nesting issues
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
        SELECT id, input_path, output_path, status, job_cost, model_version, priority, processing_time_ms, error_message, created_at, started_at, completed_at
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

      // Flattened response structure so api.ts can map properties directly to statusResponse.data
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
   * Cancels a queued or blocked job.
   */
  cancelJob: async (req: Request, res: Response): Promise<void> => {
    const { profile_id } = req.user!;
    const jobId = req.params.id as string;

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

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

      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: `Cannot cancel a job with status '${job.status}'.` });
        return;
      }

      if (job.status === 'processing' || job.status === 'initiated') {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: 'Cannot cancel an actively running job.' });
        return;
      }

      await client.query(
        `UPDATE jobs SET status = 'cancelled', completed_at = NOW() WHERE id = $1;`,
        [jobId]
      );

      if (job.status === 'queued') {
        const profileResult = await client.query(
          `SELECT current_credit_balance, reserved_credits FROM profiles WHERE id = $1 FOR UPDATE;`,
          [profile_id as string]
        );
        
        if (profileResult.rowCount !== null && profileResult.rowCount > 0) {
          // ⚠️ FIX: Destructure current_credit_balance instead of credits
          const { current_credit_balance, reserved_credits } = profileResult.rows[0];
          const newReserved = Math.max(0, reserved_credits - job.job_cost);

          await client.query(
            `UPDATE profiles SET reserved_credits = $1 WHERE id = $2;`,
            [newReserved, profile_id as string]
          );

          // ⚠️ FIX: Perform math on current_credit_balance instead of credits
          const newAvailableBalance = current_credit_balance - newReserved;
          await client.query(
            `INSERT INTO credit_transactions (profile_id, transaction_type, amount, balance_after, reference_job_id, notes)
             VALUES ($1, $2, $3, $4, $5, $6);`,
            [
              profile_id as string, // $1
              'reservation_release', // $2 (transaction_type)
              job.job_cost,         // $3 (amount)
              newAvailableBalance,  // $4 (balance_after)
              jobId,                // $5 (reference_job_id)
              `Released ${job.job_cost} reserved credits due to job cancellation` // $6 (notes)
            ]
          );

          console.log(`[cancelJob] Released ${job.job_cost} reserved credits for profile ${profile_id}`);
        }
      }

      await client.query('COMMIT');

      res.status(200).json({
        success: true,
        message: job.status === 'queued'
          ? 'Job successfully cancelled. Reserved credits have been returned to your available balance.'
          : 'Job successfully cancelled.'
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