// src/controllers/feedback.controller.ts
import { Request, Response } from 'express';
import { pool } from '../config/db';

export const feedbackController = {
  /**
   * Submits a verified user feedback entry to the database ledger.
   * POST /api/feedback
   */
  submitFeedback: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!; // Explicitly reads profile_id from requireAuth token payload
      const { rating, name, email, type, message } = req.body;

      // 1. Basic inputs presence verification
      if (!rating || !name || !email || !type || !message) {
        res.status(400).json({ success: false, error: 'All fields are required.' });
        return;
      }

      // 2. Validate range boundaries
      const parsedRating = parseInt(rating as string, 10);
      if (isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5) {
        res.status(400).json({ success: false, error: 'Rating must be an integer between 1 and 5.' });
        return;
      }

      // 3. Insert record into database
      const insertQuery = `
        INSERT INTO feedbacks (profile_id, rating, name, email, feedback_type, message)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, created_at;
      `;
      
      const result = await pool.query(insertQuery, [
        profile_id as string,
        parsedRating,
        name,
        email,
        type,
        message
      ]);

      res.status(201).json({
        success: true,
        message: 'Feedback logged successfully.',
        data: result.rows[0]
      });

    } catch (error) {
      console.error('[feedbackController][submitFeedback] Error logging feedback:', error);
      res.status(500).json({ success: false, error: 'Internal server error submitting feedback.' });
    }
  }
};