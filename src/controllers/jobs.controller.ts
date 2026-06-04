// src/controllers/jobs.controller.ts
import { Request, Response } from 'express';
import { pool } from '../config/db';
import { paymentRepository } from '../repositories/payment.repository';

export const jobsController = {
  /**
   * Submits an AI processing job.
   * Performs real-time FIFO credit deduction. Sets status to 'blocked' if credits are insufficient [1.2.4].
   * POST /api/jobs
   */
  submitJob: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      const { projectId, inputPath, jobCost, modelVersion, priority } = req.body;

      if (!projectId || !inputPath || !jobCost || !modelVersion) {
        res.status(400).json({ success: false, error: 'projectId, inputPath, jobCost, and modelVersion are required.' });
        return;
      }

      if (parseInt(jobCost as string, 10) <= 0) {
        res.status(400).json({ success: false, error: 'Job cost must be a positive integer.' });
        return;
      }

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const pId = projectId as string; // Assert strictly as string [1.3.1]

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

        // 2. Lock profile row FOR UPDATE to prevent balance modification race conditions [1.2.4]
        const profile = await paymentRepository.lockProfileForUpdate(profile_id as string, client);

        const cost = parseInt(jobCost as string, 10);
        const hasEnoughCredits = profile.current_credit_balance >= cost;

        let finalStatus: 'queued' | 'blocked' = 'queued';

        if (!hasEnoughCredits) {
          // If they lack credits, flag the job as 'blocked' as per your schema [1.2.4]
          finalStatus = 'blocked';
          console.log(`[jobsController][submitJob] Insufficient credits for profile ${profile_id}. Job blocked.`);
        } else {
          // 3. FIFO Deduction: Subtract from expiring subscription allowance first [1.2.4]
          let remainingCost = cost;
          let newSubscriptionCredits = profile.subscription_credits;
          let newPurchasedCredits = profile.purchased_credits;

          if (newSubscriptionCredits >= remainingCost) {
            newSubscriptionCredits -= remainingCost;
            remainingCost = 0;
          } else {
            remainingCost -= newSubscriptionCredits;
            newSubscriptionCredits = 0;
          }

          // Deduct any remainder from non-expiring purchased top-up credits
          if (remainingCost > 0) {
            newPurchasedCredits -= remainingCost;
          }

          // 4. Save updated balance columns [1.2.4]
          await paymentRepository.updateProfileBalance(profile_id as string, newSubscriptionCredits, newPurchasedCredits, client);

          // 5. Log the ledger transaction [1.2.4]
          const totalNewBalance = newSubscriptionCredits + newPurchasedCredits;
          await paymentRepository.insertCreditTransaction({
            profile_id: profile_id as string,
            transaction_type: 'usage',
            amount: cost,
            balance_after: totalNewBalance,
            notes: `Spent ${cost} credits on AI job execution`,
          }, client);
        }

        // 6. Insert the job record into the database [1.2.4]
        const jobQuery = `
          INSERT INTO jobs (profile_id, project_id, input_path, status, job_cost, model_version, priority)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id, profile_id, project_id, input_path, status, job_cost, model_version, priority, created_at;
        `;
        const jobResult = await client.query(jobQuery, [
          profile_id as string,
          pId,
          inputPath as string,
          finalStatus,
          cost,
          modelVersion as string,
          priority || 0
        ]);

        await client.query('COMMIT');

        res.status(201).json({
          success: true,
          data: jobResult.rows[0],
          message: finalStatus === 'blocked' 
            ? 'Job registered but BLOCKED due to insufficient credits. Please top up.' 
            : 'Job successfully queued.'
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
   * GET /api/jobs
   */
  getMyJobs: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;

      const query = `
        SELECT id, project_id, input_path, output_path, status, job_cost, model_version, priority, processing_time_ms, error_message, created_at, started_at, completed_at
        FROM jobs
        WHERE profile_id = $1
        ORDER BY created_at DESC;
      `;
      const result = await pool.query(query, [profile_id as string]);

      res.status(200).json({
        success: true,
        data: result.rows,
      });
    } catch (error) {
      console.error('[jobsController][getMyJobs] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve jobs.' });
    }
  },

  /**
   * Retrieves a specific job by ID (if owned by user).
   * GET /api/jobs/:id
   */
  getJobById: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      const jobId = req.params.id as string; // Assert strictly as string [1.3.1]

      const query = `
        SELECT id, project_id, input_path, output_path, status, job_cost, model_version, priority, processing_time_ms, error_message, created_at, started_at, completed_at
        FROM jobs
        WHERE id = $1 AND profile_id = $2;
      `;
      const result = await pool.query(query, [jobId, profile_id as string]);

      if (result.rowCount === 0) {
        res.status(404).json({ success: false, error: 'Job not found.' });
        return;
      }

      res.status(200).json({
        success: true,
        data: result.rows[0],
      });
    } catch (error) {
      console.error('[jobsController][getJobById] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve job.' });
    }
  },

  /**
   * Retrieves status and processing state of a specific job [1.2.4].
   * GET /api/jobs/:id/status
   */
  getJobStatus: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      const jobId = req.params.id as string; // Assert strictly as string [1.3.1]

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

      res.status(200).json({
        success: true,
        data: result.rows[0],
      });
    } catch (error) {
      console.error('[jobsController][getJobStatus] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve job status.' });
    }
  },

  /**
   * Cancels a queued or blocked job.
   * Performs an automated refund of credits if the job is canceled before a worker begins processing [1.2.4]!
   * POST /api/jobs/:id/cancel
   */
  cancelJob: async (req: Request, res: Response): Promise<void> => {
    const { profile_id } = req.user!;
    const jobId = req.params.id as string; // Assert strictly as string [1.3.1]

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Fetch job with lock to prevent concurrent modifications
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

      // 2. Prevent cancellation of finished or already active processing jobs
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: `Cannot cancel a job with a status of '${job.status}'.` });
        return;
      }

      if (job.status === 'processing' || job.status === 'initiated') {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: 'Cannot cancel a job that is already running on a worker node.' });
        return;
      }

      // 3. Update job status to 'cancelled' [1.2.4]
      await client.query(
        `UPDATE jobs SET status = 'cancelled', completed_at = NOW() WHERE id = $1;`,
        [jobId]
      );

      // 4. Refund: If the job was 'queued' or 'blocked', refund their spent credits! [1.2.4]
      if (job.status === 'queued') {
        const profile = await paymentRepository.lockProfileForUpdate(profile_id as string, client);
        
        // Refund back to subscription allowance as standard practice [1.2.4]
        const refundedSubscriptionCredits = profile.subscription_credits + job.job_cost;
        await paymentRepository.updateProfileBalance(profile_id as string, refundedSubscriptionCredits, profile.purchased_credits, client);

        // Record refund ledger entry [1.2.4]
        await paymentRepository.insertCreditTransaction({
          profile_id: profile_id as string,
          transaction_type: 'free_grant', // Classified as refund grant
          amount: job.job_cost,
          balance_after: refundedSubscriptionCredits + profile.purchased_credits,
          notes: `Refund for cancelled job ID: ${jobId}`,
        }, client);

        console.log(`[jobsController][cancelJob] Refunded ${job.job_cost} credits to profile ${profile_id}`);
      }

      await client.query('COMMIT');

      res.status(200).json({
        success: true,
        message: job.status === 'queued' 
          ? 'Job successfully cancelled. Spent credits have been refunded to your profile balance.' 
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