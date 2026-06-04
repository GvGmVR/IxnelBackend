// src/controllers/projects.controller.ts

import { Request, Response } from 'express';
import { pool } from '../config/db';
import { storageService } from '../services/storage.service';

export const projectsController = {
  /**
   * Creates a new project in the database.
   * POST /api/projects
   */
  createProject: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      const { name, settings, storage_mode } = req.body;

      if (!name || !(name as string).trim()) {
        res.status(400).json({ success: false, error: 'Project name is required.' });
        return;
      }

      const mode = (storage_mode as string) === 'local' ? 'local' : 'cloud';
      const normalizedName = (name as string).trim();

      const query = `
        INSERT INTO projects (profile_id, name, settings, storage_mode)
        VALUES ($1, $2, $3, $4)
        RETURNING id, profile_id, name, settings, storage_mode, created_at;
      `;
      const result = await pool.query(query, [
        profile_id as string,
        normalizedName,
        settings ? JSON.stringify(settings) : '{}',
        mode
      ]);

      res.status(201).json({
        success: true,
        ...result.rows[0] // Flat-serialized directly to root [1.2.4]
      });
    } catch (error) {
      console.error('[projectsController][createProject] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to create project.' });
    }
  },

/**
   * Retrieves all projects belonging to the authenticated user.
   * GET /api/projects
   */
  getProjects: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;

      // ─── DIAGNOSTIC LOGS ───
      console.log('------------------ PROJECTS DIAGNOSTICS ------------------');
      console.log('[DEBUG] Querying profileId:', profile_id);
      
      const query = `
        SELECT id, name, settings, storage_mode, thumbnail_url, updated_at, created_at
        FROM projects
        WHERE profile_id = $1
        ORDER BY updated_at DESC;
      `;
      const result = await pool.query(query, [profile_id as string]);

      console.log('[DEBUG] Rows returned from Database:', result.rowCount);
      if (result.rowCount && result.rowCount > 0) {
        console.log('[DEBUG] First Row details:', result.rows[0]);
      }
      console.log('----------------------------------------------------------');

      res.status(200).json({
        success: true,
        projects: result.rows,
      });
    } catch (error) {
      console.error('[projectsController][getProjects] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve projects.' });
    }
  },

  /**
   * Retrieves detailed project information, including associated assets.
   * GET /api/projects/:id
   */
  getProjectById: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      const projectId = req.params.id as string;

      const projectResult = await pool.query(
        `SELECT id, name, settings, storage_mode, thumbnail_url, created_at, updated_at
         FROM projects
         WHERE id = $1 AND profile_id = $2;`,
        [projectId, profile_id as string]
      );

      if (projectResult.rowCount === 0) {
        res.status(404).json({ success: false, error: 'Project not found.' });
        return;
      }

      // Fetch all associated assets for the canvas timeline
      const assetsResult = await pool.query(
        `SELECT id, asset_type, storage_key, file_url, frame_number, created_at
         FROM project_assets
         WHERE project_id = $1
         ORDER BY frame_number ASC, created_at ASC;`,
        [projectId]
      );

      res.status(200).json({
        success: true,
        project: {
          ...projectResult.rows[0],
          assets: assetsResult.rows,
        } // Returned as named object [1.2.4]
      });
    } catch (error) {
      console.error('[projectsController][getProjectById] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve project details.' });
    }
  },

  /**
   * Evaluates storage thresholds and returns temporary presigned upload parameters [1.2.4].
   * POST /api/projects/:id/assets/presign
   */
  presignAsset: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      const projectId = req.params.id as string;
      const { fileName, contentType, fileSizeBytes } = req.body;

      if (!fileName || !contentType || !fileSizeBytes) {
        res.status(400).json({ success: false, error: 'fileName, contentType, and fileSizeBytes are required.' });
        return;
      }

      const projectCheck = await pool.query(
        `SELECT storage_mode FROM projects WHERE id = $1 AND profile_id = $2;`,
        [projectId, profile_id as string]
      );

      if (projectCheck.rowCount === 0) {
        res.status(404).json({ success: false, error: 'Project not found.' });
        return;
      }

      const { storage_mode } = projectCheck.rows[0];

      if (storage_mode === 'local') {
        res.status(400).json({ success: false, error: 'Local-mode projects cannot upload assets to Cloud Storage.' });
        return;
      }

      const credentials = await storageService.generatePresignedUploadUrl(
        profile_id as string,
        projectId,
        fileName as string,
        contentType as string,
        parseInt(fileSizeBytes as string, 10)
      );

      res.status(200).json({
        success: true,
        ...credentials // Spreads credentials directly to root [1.2.4]
      });
    } catch (error) {
      console.error('[projectsController][presignAsset] Error:', error);
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate upload credentials.',
      });
    }
  },

  /**
   * Deletes a project and cascade-wipes all its associated timeline assets [1.2.4].
   * DELETE /api/projects/:id
   */
  deleteProject: async (req: Request, res: Response): Promise<void> => {
    try {
      const { profile_id } = req.user!;
      const projectId = req.params.id as string;

      console.log(`[projectsController][deleteProject] Deleting project ${projectId} for profile ${profile_id}`);

      // Deletes the row from projects (CASCADE constraint automatically wipes project_assets and jobs) [1.2.4]
      const result = await pool.query(
        `DELETE FROM projects WHERE id = $1 AND profile_id = $2 RETURNING id;`,
        [projectId, profile_id as string]
      );

      if (result.rowCount === 0) {
        res.status(404).json({ success: false, error: 'Project not found or unauthorized.' });
        return;
      }

      res.status(200).json({ success: true, message: 'Project deleted successfully.' });
    } catch (error) {
      console.error('[projectsController][deleteProject] Error:', error);
      res.status(500).json({ success: false, error: 'Internal server error deleting project.' });
    }
  }
};