// src/routes/projects.routes.ts
import express from 'express';
import { projectsController } from '../controllers/projects.controller';
import { requireAuth } from '../middleware/requireAuth';

const router = express.Router();

/**
 * 1. Create a New Project (Authenticated)
 * POST /api/projects
 */
router.post('/', requireAuth, projectsController.createProject);

/**
 * 2. Get All Projects belonging to User (Authenticated)
 * GET /api/projects
 */
router.get('/', requireAuth, projectsController.getProjects);

/**
 * 3. Get Project Details and Timeline Assets (Authenticated)
 * GET /api/projects/:id
 */
router.get('/:id', requireAuth, projectsController.getProjectById);

/**
 * 4. Generate secure upload parameters for Cloud Storage (Authenticated)
 * POST /api/projects/:id/assets/presign
 */
router.post('/:id/assets/presign', requireAuth, projectsController.presignAsset);

/**
 * 5. Delete Project (Authenticated)
 * Cascade wipes the project, associated assets, and jobs under safe DB constraints [1.2.4]
 */
router.delete('/:id', requireAuth, projectsController.deleteProject);

export default router;