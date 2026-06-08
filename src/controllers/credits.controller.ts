// src/controllers/credits.controller.ts
import { Request, Response } from 'express';
import { pool } from '../config/db';

/**
 * Retrieves the credit balance details of the authenticated user.
 * GET /api/credits/balance
 */
export const getCreditBalance = async (req: Request, res: Response): Promise<void> => {
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
      data: {
        total_credits: current_credit_balance,
        reserved_credits: reserved_credits,
        available_credits: available_credits
      }
    });
  } catch (error) {
    console.error('[getCreditBalance] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve credit balance.' });
  }
};

/**
 * Retrieves the credit transaction audit trail for the authenticated user.
 * GET /api/credits/transactions
 */
export const getCreditTransactions = async (req: Request, res: Response): Promise<void> => {
  try {
    const { profile_id } = req.user!;

    const query = `
      SELECT id, transaction_type, amount, balance_after, reference_job_id, notes, created_at
      FROM credit_transactions
      WHERE profile_id = $1
      ORDER BY created_at DESC;
    `;
    const result = await pool.query(query, [profile_id as string]);

    res.status(200).json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('[getCreditTransactions] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve transactions.' });
  }
};

/**
 * Retrieves details of a specific transaction by ID.
 * GET /api/credits/transactions/:id
 */
export const getCreditTransactionById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { profile_id } = req.user!;
    const transactionId = req.params.id as string;

    const query = `
      SELECT id, transaction_type, amount, balance_after, reference_job_id, notes, created_at
      FROM credit_transactions
      WHERE id = $1 AND profile_id = $2;
    `;
    const result = await pool.query(query, [transactionId, profile_id as string]);

    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Transaction record not found.' });
      return;
    }

    res.status(200).json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('[getCreditTransactionById] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve transaction detail.' });
  }
};