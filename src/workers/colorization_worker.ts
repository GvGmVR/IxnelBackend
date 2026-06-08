// src/workers/colorization_worker.ts
import { pool } from '../config/db';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs'; // Imported fsSync to check file existence at startup
import { createWriteStream } from 'fs';

const AdmZip = require('adm-zip') as any;

const POLL_INTERVAL_MS = 2000;

// 1. Configured to point directly to your external AnimeColor repo on Windows
const SUBMODULE_DIR = 'D:\\Ixnel\\dev\\AnimeColor\\workspace';

// 2. Define both potential Windows venv path configurations
const pathA = path.join(SUBMODULE_DIR, 'AnimeColor_Code', 'venv', 'Scripts', 'python.exe');
const pathB = path.join(SUBMODULE_DIR, 'venv', 'Scripts', 'python.exe');

// 3. Self-healing resolution: Choose whichever path actually exists on your hard drive
const PYTHON_PATH = fsSync.existsSync(pathA) ? pathA : pathB;

// 4. Point to run_animecolor.py (which contains our CLI argument parser)
const MODEL_SCRIPT = path.join(SUBMODULE_DIR, 'run_animecolor.py'); 

console.log(`[Worker] Path Resolution Verified:`);
console.log(`         PYTHON_PATH  -> ${PYTHON_PATH}`);
console.log(`         MODEL_SCRIPT -> ${MODEL_SCRIPT}`);

/**
 * Compresses folder directory contents into a zip archive using adm-zip.
 */
function zipDirectory(sourceDir: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const zip = new AdmZip();
      
      // Adds the folder and all its contents natively
      zip.addLocalFolder(sourceDir);
      
      // Writes the compiled package directly to disk synchronously
      zip.writeZip(outPath);
      
      resolve();
    } catch (err) {
      console.error('[Worker][zipDirectory] Compression failed:', err);
      reject(err);
    }
  });
}

/**
 * Queries and updates the oldest queued job in a thread-safe database transaction.
 */
async function fetchAndLockJob() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Atomic fetch-and-lock leveraging index optimization
    const query = `
      SELECT id, profile_id, input_path, job_cost 
      FROM jobs 
      WHERE status = 'queued' 
      ORDER BY priority DESC, created_at ASC 
      LIMIT 1 
      FOR UPDATE SKIP LOCKED;
    `;
    const result = await client.query(query);

    if (result.rowCount === 0) {
      await client.query('COMMIT');
      return null;
    }

    const job = result.rows[0];

    // Transition status to locked state immediately
    await client.query(
      `UPDATE jobs SET status = 'initiated', started_at = NOW() WHERE id = $1;`,
      [job.id]
    );

    await client.query('COMMIT');
    return job;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Worker] Error locking job:', error);
    return null;
  } finally {
    client.release();
  }
}

/**
 * Handles permanent deduction steps on successful completion of inference (with FIFO column sync).
 */
async function finalizeSuccess(jobId: string, profileId: string, cost: number, zipPath: string, elapsedMs: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Terminate job status details
    await client.query(
      `UPDATE jobs 
       SET status = 'completed', output_path = $1, completed_at = NOW(), processing_time_ms = $2 
       WHERE id = $3;`,
      [zipPath, elapsedMs, jobId]
    );

    // 2. Lock profile (selecting all active columns for FIFO calculations)
    const profileResult = await client.query(
      `SELECT current_credit_balance, subscription_credits, purchased_credits, reserved_credits, total_credits_used 
       FROM profiles 
       WHERE id = $1 FOR UPDATE;`,
      [profileId]
    );

    if (profileResult.rowCount != null && profileResult.rowCount > 0) {
      const { 
        current_credit_balance, 
        subscription_credits, 
        purchased_credits, 
        reserved_credits, 
        total_credits_used 
      } = profileResult.rows[0];
      
      let remainingCost = cost;
      let newSubscriptionCredits = subscription_credits || 0;
      let newPurchasedCredits = purchased_credits || 0;

      // FIFO Deduction: Subtract from subscription allowance first
      if (newSubscriptionCredits >= remainingCost) {
        newSubscriptionCredits -= remainingCost;
        remainingCost = 0;
      } else {
        remainingCost -= newSubscriptionCredits;
        newSubscriptionCredits = 0;
      }

      // Deduct any remainder from non-expiring purchased top-up credits
      if (remainingCost > 0) {
        newPurchasedCredits = Math.max(0, newPurchasedCredits - remainingCost);
      }

      const newCredits = newSubscriptionCredits + newPurchasedCredits;
      const newReserved = Math.max(0, reserved_credits - cost);
      const newTotalUsed = (total_credits_used || 0) + cost;

      // Synchronize all columns in a single transaction query [1.2.4]
      await client.query(
        `UPDATE profiles 
         SET 
           subscription_credits = $1, 
           purchased_credits = $2, 
           current_credit_balance = $3, 
           reserved_credits = $4, 
           total_credits_used = $5 
         WHERE id = $6;`,
        [newSubscriptionCredits, newPurchasedCredits, newCredits, newReserved, newTotalUsed, profileId]
      );

      // 3. Write permanent ledger entry
      await client.query(
        `INSERT INTO credit_transactions (profile_id, transaction_type, amount, balance_after, reference_job_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6);`,
        [
          profileId,             // $1
          'job_deduction',       // $2
          -cost,                 // $3
          newCredits - newReserved, // $4
          jobId,                 // $5
          `Permanently deducted ${cost} credits for completed colorization render` // $6
        ]
      );
    }

    await client.query('COMMIT');
    console.log(`[Worker] Job ${jobId} finalized successfully. Deduction complete.`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[Worker] Failed finalizing success transaction for job ${jobId}:`, error);
  } finally {
    client.release();
  }
}

/**
 * Reverts credit reservations if a job failure occurred during the process execution.
 */
async function finalizeFailure(jobId: string, profileId: string, cost: number, errorMsg: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Update status flag with execution logs
    await client.query(
      `UPDATE jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2;`,
      [errorMsg, jobId]
    );

    // 2. Unlock reserved tokens from client balance (Aligned to active current_credit_balance column)
    const profileResult = await client.query(
      `SELECT current_credit_balance, reserved_credits FROM profiles WHERE id = $1 FOR UPDATE;`,
      [profileId]
    );

    if (profileResult.rowCount != null && profileResult.rowCount > 0) {
      // ⚠️ FIX: Destructure current_credit_balance instead of credits
      const { current_credit_balance, reserved_credits } = profileResult.rows[0];
      const newReserved = Math.max(0, reserved_credits - cost);

      await client.query(
        `UPDATE profiles SET reserved_credits = $1 WHERE id = $2;`,
        [newReserved, profileId]
      );

      // 3. Document the reverse ledger reservation release (using active current_credit_balance)
      const finalAvailableBalance = current_credit_balance - newReserved;
      await client.query(
        `INSERT INTO credit_transactions (profile_id, transaction_type, amount, balance_after, reference_job_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6);`,
        [
          profileId,             // $1
          'reservation_release', // $2
          cost,                  // $3
          finalAvailableBalance, // $4
          jobId,                 // $5
          `Released ${cost} reserved credits due to rendering execution failure` // $6
        ]
      );

    }

    await client.query('COMMIT');
    console.log(`[Worker] Job ${jobId} marked as failed. Reserved credits released.`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[Worker] Failed finalizing failure release for job ${jobId}:`, error);
  } finally {
    client.release();
  }
}

/**
 * Execution thread mapping and Python process spawning logic with real-time terminal diagnostics.
 */
async function processJob(job: any) {
  const startTimestamp = Date.now();
  const jobDir = job.input_path; // points to: temp/jobs/{jobId}
  const framesDir = path.join(jobDir, 'frames');
  const outputDir = path.join(jobDir, 'output');
  const zipFileLocation = path.join(jobDir, 'colorized_sequence.zip');

  console.log('\n======================================================================');
  console.log(`🚀 [Worker] Job ID ${job.id} - INITIATED EXECUTION PIPELINE`);
  console.log(`📂 [Worker] Temporary Workspace: ${jobDir}`);
  console.log(`🐍 [Worker] Executing python file ran! Target Venv: ${PYTHON_PATH}`);
  console.log(`📜 [Worker] Inference Script: ${MODEL_SCRIPT}`);
  console.log('======================================================================\n');

  // Dynamically resolve reference image in the directory
  let refImageName = 'reference.png';
  try {
    const filesInDir = await fs.readdir(jobDir);
    const refFile = filesInDir.find(f => f.startsWith('reference.'));
    if (refFile) refImageName = refFile;
  } catch (err) {
    console.warn('⚠️ [Worker] Directory read warning while locating reference image:', err);
  }
  const refImagePath = path.join(jobDir, refImageName);

  try {
    // 1. Update status to 'processing' in the database
    await pool.query(`UPDATE jobs SET status = 'processing' WHERE id = $1;`, [job.id]);

    // Prepare target output directory
    await fs.mkdir(outputDir, { recursive: true });

    // Determine arguments based on Local Mode
    let spawnArgs: string[] = [];
    const isLocalMode = true; 

    if (isLocalMode) {
      spawnArgs = [
        MODEL_SCRIPT,
        '--base_path', SUBMODULE_DIR,
        '--lineart_dir', framesDir,
        '--ref_image', refImagePath,
        '--output_dir', outputDir,
        '--output_fps', '24' // Default/Calculated dynamically
      ];
    } else {
      const jsonConfigPath = path.join(jobDir, 'job_config.json');
      spawnArgs = [MODEL_SCRIPT, '--config', jsonConfigPath];
    }

    console.log(`⚙️ [Worker] Executing file-inference: Spawning python process now...`);

    // 2. Spawn Python directly from the external AnimeColor repository location
    const pythonProcess = spawn(PYTHON_PATH, spawnArgs, {
      cwd: SUBMODULE_DIR,
      env: { ...process.env }
    });

    let stdoutLog = '';
    let stderrLog = '';

    // Stream stdout directly to your Node.js console in real-time
    pythonProcess.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdoutLog += chunk;
      process.stdout.write(`🐍 [Python stdout] ${chunk}`); // Prints model progress immediately
    });

    // Stream stderr directly to your Node.js console in real-time
    pythonProcess.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderrLog += chunk;
      process.stderr.write(`⚠️ [Python stderr] ${chunk}`); // Prints errors/warnings immediately
    });

    pythonProcess.on('close', async (code) => {
      const elapsedMs = Date.now() - startTimestamp;

      console.log(`\n======================================================================`);
      console.log(`🏁 [Worker] Python Process closed with exit code: ${code}`);

      if (code !== 0) {
        const errorDetails = stderrLog || `Inference error. Exit code: ${code}`;
        console.error(`⚠️ [Worker] Job ${job.id} execution failed:`, errorDetails);
        await finalizeFailure(job.id, job.profile_id, job.job_cost, errorDetails);
        
        // Immediate cleanup on failure
        await cleanUpJobDirectory(jobDir);
        console.log('======================================================================\n');
        return;
      }

      try {
        console.log(`📦 [Worker] Compiling outputs to zip file...`);
        // 3. Compile output frames to a single downloadable ZIP
        await zipDirectory(outputDir, zipFileLocation);
        console.log(`✅ [Worker] Zip created successfully: ${zipFileLocation}`);

        const relativeZipDownloadPath = `/downloads/${job.id}/colorized_sequence.zip`;

        // 4. Finalize database success metrics
        await finalizeSuccess(job.id, job.profile_id, job.job_cost, relativeZipDownloadPath, elapsedMs);

        // 5. PRIVACY PURGE: Delete transient directories immediately after compilation
        console.log(`🧹 [Worker] Initiating Privacy Purge. Deleting transient raw folders...`);
        await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(refImagePath, { force: true }).catch(() => {});
        console.log(`🧹 [Worker] Job finished! Temp raw frames and references deleted successfully.`);
        console.log('======================================================================\n');

      } catch (zipError: any) {
        console.error(`⚠️ [Worker] Compression error on job ${job.id}:`, zipError);
        await finalizeFailure(job.id, job.profile_id, job.job_cost, `Packaging failure: ${zipError?.message}`);
        await cleanUpJobDirectory(jobDir);
        console.log('======================================================================\n');
      }
    });

  } catch (error: any) {
    console.error(`⚠️ [Worker] Unexpected loop exception on job ${job.id}:`, error);
    await finalizeFailure(job.id, job.profile_id, job.job_cost, error?.message || 'Unexpected worker exception');
    await cleanUpJobDirectory(jobDir);
    console.log('======================================================================\n');
  }
}

/**
 * Clean up helper to ensure zero lingering footprint.
 */
async function cleanUpJobDirectory(dirPath: string) {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
    console.log(`[Worker] Transient disk directory wiped cleanly: ${dirPath}`);
  } catch (err) {
    console.error('[Worker] Directory cleanup error:', err);
  }
}

/**
 * Polling daemon initialization.
 */
async function startWorker() {
  console.log('[Worker] Daemon initialized. Listening for queued rendering jobs...');

  setInterval(async () => {
    try {
      const job = await fetchAndLockJob();
      if (job) {
        await processJob(job);
      }
    } catch (err) {
      console.error('[Worker] Unhandled loop error:', err);
    }
  }, POLL_INTERVAL_MS);
}

// Spawn the worker loop
startWorker();