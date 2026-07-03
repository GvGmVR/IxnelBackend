// src/workers/colorization_worker.ts
import { pool } from '../config/db';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { createWriteStream } from 'fs';
import { activeProcesses } from '../utils/processManager';

import { execSync } from 'child_process';
import os from 'os';

function checkGPUMemory(): { free: number; total: number } | null {
    try {
        const output = execSync(
            'nvidia-smi --query-gpu=memory.free,memory.total --format=csv,noheader,nounits',
            { encoding: 'utf8', timeout: 5000 }
        );
        const [free, total] = output.trim().split(',').map(s => parseInt(s.trim()));
        return { free, total };
    } catch (err) {
        console.warn('[Worker] Could not query GPU memory (nvidia-smi not available)');
        return null;
    }
}

const AdmZip = require('adm-zip') as any;

const POLL_INTERVAL_MS = 2000;

// 1. Configured to point directly to your external AnimeColor repo on Windows
const SUBMODULE_DIR = 'D:\\Ixnel\\dev\\AnimeColor\\workspace';

// 2. Define both potential Windows venv path configurations
const pathA = path.join(SUBMODULE_DIR, 'AnimeColor_Code', 'venv', 'Scripts', 'python.exe');
const pathB = path.join(SUBMODULE_DIR, 'venv', 'Scripts', 'python.exe');

// 3. Self-healing resolution: Choose whichever path actually exists
const PYTHON_PATH = fsSync.existsSync(pathA) ? pathA : pathB;

// 4. Point to run_animecolor.py
const MODEL_SCRIPT = path.join(SUBMODULE_DIR, 'run_animecolor.py');

console.log(`[Worker] Path Resolution Verified:`);
console.log(`         PYTHON_PATH  -> ${PYTHON_PATH}`);
console.log(`         MODEL_SCRIPT -> ${MODEL_SCRIPT}`);

// ─── PYTHON SUBPROCESS ENVIRONMENT ───────────────────────────────────────────
// Forces UTF-8 encoding on the Python subprocess stdout/stderr pipes.
// Without this, Windows CP1252 terminal encoding crashes on any Unicode
// character (emoji, arrows, etc.) that Python tries to print.
//
// PYTHONIOENCODING=utf-8   → sets stdin/stdout/stderr codec to UTF-8
// PYTHONUTF8=1             → enables Python 3.7+ UTF-8 mode globally
//                            (affects file I/O, locale, etc. — defense in depth)
// PYTHONLEGACYWINDOWSSTDIO is explicitly NOT set — that would re-enable CP1252
const PYTHON_ENV = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
};

/**
 * Compresses folder directory contents into a zip archive using adm-zip.
 */
function zipDirectory(sourceDir: string, outPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            const zip = new AdmZip();
            zip.addLocalFolder(sourceDir);
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
 * Handles permanent deduction steps on successful completion of inference.
 */
async function finalizeSuccess(
    jobId: string,
    profileId: string,
    cost: number,
    zipPath: string,
    elapsedMs: number
) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            `UPDATE jobs 
             SET status = 'completed', output_path = $1, completed_at = NOW(), processing_time_ms = $2 
             WHERE id = $3;`,
            [zipPath, elapsedMs, jobId]
        );

        const profileResult = await client.query(
            `SELECT current_credit_balance, subscription_credits, purchased_credits, 
                    reserved_credits, total_credits_used 
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

            // FIFO Deduction: subscription first
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

            const newCredits   = newSubscriptionCredits + newPurchasedCredits;
            const newReserved  = Math.max(0, reserved_credits - cost);
            const newTotalUsed = (total_credits_used || 0) + cost;

            await client.query(
                `UPDATE profiles 
                 SET 
                     subscription_credits    = $1, 
                     purchased_credits       = $2, 
                     current_credit_balance  = $3, 
                     reserved_credits        = $4, 
                     total_credits_used      = $5 
                 WHERE id = $6;`,
                [newSubscriptionCredits, newPurchasedCredits, newCredits, newReserved, newTotalUsed, profileId]
            );

            await client.query(
                `INSERT INTO credit_transactions 
                     (profile_id, transaction_type, amount, balance_after, reference_job_id, notes)
                 VALUES ($1, $2, $3, $4, $5, $6);`,
                [
                    profileId,
                    'job_deduction',
                    -cost,
                    newCredits - newReserved,
                    jobId,
                    `Permanently deducted ${cost} credits for completed colorization render`
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
 * Reverts credit reservations if a job failure occurred.
 */
async function finalizeFailure(
    jobId: string,
    profileId: string,
    cost: number,
    errorMsg: string
) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            `UPDATE jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2;`,
            [errorMsg, jobId]
        );

        const profileResult = await client.query(
            `SELECT current_credit_balance, reserved_credits FROM profiles WHERE id = $1 FOR UPDATE;`,
            [profileId]
        );

        if (profileResult.rowCount != null && profileResult.rowCount > 0) {
            const { current_credit_balance, reserved_credits } = profileResult.rows[0];
            const newReserved = Math.max(0, reserved_credits - cost);

            await client.query(
                `UPDATE profiles SET reserved_credits = $1 WHERE id = $2;`,
                [newReserved, profileId]
            );

            const finalAvailableBalance = current_credit_balance - newReserved;
            await client.query(
                `INSERT INTO credit_transactions 
                     (profile_id, transaction_type, amount, balance_after, reference_job_id, notes)
                 VALUES ($1, $2, $3, $4, $5, $6);`,
                [
                    profileId,
                    'reservation_release',
                    cost,
                    finalAvailableBalance,
                    jobId,
                    `Released ${cost} reserved credits due to rendering execution failure`
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
 * Execution thread mapping and Python process spawning logic.
 */
async function processJob(job: any) {
    const startTimestamp = Date.now();
    const jobDir         = job.input_path;
    const framesDir      = path.join(jobDir, 'frames');
    const outputDir      = path.join(jobDir, 'output');
    const zipFileLocation = path.join(jobDir, 'colorized_sequence.zip');

    console.log('\n======================================================================');
    console.log(`[Worker] Job ID ${job.id} - INITIATED EXECUTION PIPELINE`);
    console.log(`[Worker] Temporary Workspace : ${jobDir}`);
    console.log(`[Worker] Target Venv         : ${PYTHON_PATH}`);
    console.log(`[Worker] Inference Script    : ${MODEL_SCRIPT}`);
    console.log('======================================================================\n');

    // Dynamically resolve reference image
    let refImageName = 'reference.png';
    try {
        const filesInDir = await fs.readdir(jobDir);
        const refFile = filesInDir.find(f => f.startsWith('reference.'));
        if (refFile) refImageName = refFile;
    } catch (err) {
        console.warn('[Worker] Directory read warning while locating reference image:', err);
    }
    const refImagePath = path.join(jobDir, refImageName);

    try {
        // Guard against race conditions with cancelled jobs
        const updateResult = await pool.query(
            `UPDATE jobs SET status = 'processing' WHERE id = $1 AND status = 'initiated' RETURNING status;`,
            [job.id]
        );

        if (updateResult.rowCount === 0) {
            console.log(`[Worker] Job ${job.id} status changed before execution (possibly cancelled). Aborting.`);
            return;
        }

        await fs.mkdir(outputDir, { recursive: true });

        // ─── BUILD SPAWN ARGS ─────────────────────────────────────────────────
        let spawnArgs: string[] = [];
        const isLocalMode = true;

        if (isLocalMode) {
            spawnArgs = [
                MODEL_SCRIPT,
                '--base_path', SUBMODULE_DIR,
                '--lineart_dir', framesDir,
                '--ref_image',   refImagePath,
                '--output_dir',  outputDir,
                '--output_fps',  '24'
            ];
        } else {
            const jsonConfigPath = path.join(jobDir, 'job_config.json');
            spawnArgs = [MODEL_SCRIPT, '--config', jsonConfigPath];
        }

        // ─── PRE-FLIGHT GPU CHECK ─────────────────────────────────────────────
        console.log(`[Worker] Pre-flight GPU check...`);
        const gpuMem = checkGPUMemory();

        if (gpuMem) {
            const freeGB  = gpuMem.free  / 1024;
            const totalGB = gpuMem.total / 1024;
            console.log(`[Worker] GPU Memory: ${freeGB.toFixed(2)} GB free / ${totalGB.toFixed(2)} GB total`);

            if (freeGB < 6.0) {
                const errorMsg = (
                    `Insufficient GPU memory: ${freeGB.toFixed(2)} GB free (need at least 6 GB). ` +
                    `Close other GPU applications and try again.`
                );
                console.error(`[Worker] ${errorMsg}`);
                await finalizeFailure(job.id, job.profile_id, job.job_cost, errorMsg);
                await cleanUpJobDirectory(jobDir);
                console.log('======================================================================\n');
                return;
            }
        } else {
            console.warn(`[Worker] Could not verify VRAM — proceeding with caution`);
        }

        // ─── SPAWN PYTHON SUBPROCESS ──────────────────────────────────────────
        // PYTHON_ENV forces UTF-8 encoding on stdout/stderr to prevent
        // UnicodeEncodeError on Windows CP1252 terminals when Python prints
        // any non-ASCII character (e.g. progress indicators, box-drawing chars).
        console.log(`[Worker] Spawning Python process...`);
        console.log(`[Worker] Encoding: PYTHONIOENCODING=${PYTHON_ENV.PYTHONIOENCODING}, PYTHONUTF8=${PYTHON_ENV.PYTHONUTF8}`);

        const pythonProcess = spawn(PYTHON_PATH, spawnArgs, {
            cwd: SUBMODULE_DIR,
            env: PYTHON_ENV,        // ← FIXED: was { ...process.env } which inherited CP1252
            windowsHide: true
        });

        activeProcesses.set(job.id, pythonProcess);

        let stdoutLog        = '';
        let stderrLog        = '';
        let lastProgressLine = '';

        // ─── STDOUT HANDLER ───────────────────────────────────────────────────
        pythonProcess.stdout.on('data', (data: Buffer) => {
            // Decode buffer explicitly as UTF-8 — do NOT use .toString() without
            // specifying encoding, as it defaults to the system locale on Windows.
            const chunk = data.toString('utf8');
            stdoutLog += chunk;

            const lines = chunk.split('\n').filter((l: string) => l.trim());
            if (lines.length > 0) {
                lastProgressLine = lines[lines.length - 1];
            }

            process.stdout.write(`[Python stdout] ${chunk}`);
        });

        // ─── STDERR HANDLER ───────────────────────────────────────────────────
        pythonProcess.stderr.on('data', (data: Buffer) => {
            // Same explicit UTF-8 decode for stderr — protects against
            // Python warning/traceback lines containing Unicode characters.
            const chunk = data.toString('utf8');
            stderrLog += chunk;

            if (
                !chunk.includes('vit_huge_patch16_224') &&
                !chunk.includes('No pretrained configuration')
            ) {
                process.stderr.write(`[Python stderr] ${chunk}`);
            }
        });

        // ─── PROCESS EXIT HANDLER ─────────────────────────────────────────────
        pythonProcess.on('close', async (code: number | null) => {
            const elapsedMs = Date.now() - startTimestamp;

            // Check if job was cancelled mid-execution
            const statusCheck = await pool.query(
                `SELECT status FROM jobs WHERE id = $1;`,
                [job.id]
            );
            const currentDbStatus = statusCheck.rows[0]?.status;

            if (currentDbStatus === 'cancelled') {
                console.log(`[Worker] Job ${job.id} was cancelled. Skipping post-processing.`);
                activeProcesses.delete(job.id);
                return;
            }

            activeProcesses.delete(job.id);

            console.log(`\n${'='.repeat(70)}`);
            console.log(`[Worker] Python Process closed with exit code: ${code}`);

            // ─── CRASH DETECTION (Windows-specific exit codes) ────────────────
            const isFatalCrash = code !== null && (
                code === 3221226505 ||   // STATUS_STACK_BUFFER_OVERRUN
                code === 3221225477 ||   // STATUS_ACCESS_VIOLATION
                code === 3221225725 ||   // STATUS_DLL_NOT_FOUND
                code === -1073741819     // STATUS_ACCESS_VIOLATION (signed)
            );

            if (isFatalCrash) {
                let crashReason = 'Unknown GPU/driver crash';

                if (code === 3221226505 || code === -1073741819) {
                    crashReason = 'GPU driver crash (memory corruption or CUDA version mismatch)';
                } else if (code === 3221225725) {
                    crashReason = 'Missing system DLL (CUDA toolkit or Visual C++ runtime)';
                }

                const diagnostics = [
                    `Exit code     : ${code} (0x${(code >>> 0).toString(16).toUpperCase()})`,
                    `Last progress : ${lastProgressLine || 'Crashed before any output'}`,
                    `Stderr        : ${stderrLog.substring(0, 500)}`,
                    `Free RAM      : ${(os.freemem() / (1024 ** 3)).toFixed(2)} GB`
                ].join('\n   ');

                const errorMsg = (
                    `${crashReason}\n\nDiagnostics:\n   ${diagnostics}\n\n` +
                    `Actions:\n   1. Run: nvidia-smi\n   2. Restart the server\n   3. Update NVIDIA drivers`
                );

                console.error(`[Worker] FATAL CRASH DETECTED:\n${errorMsg}`);
                await finalizeFailure(job.id, job.profile_id, job.job_cost, errorMsg);
                await cleanUpJobDirectory(jobDir);
                console.log(`${'='.repeat(70)}\n`);
                return;
            }

            // ─── NORMAL PYTHON ERROR ──────────────────────────────────────────
            if (code !== 0) {
                const errorDetails = stderrLog || stdoutLog || `Python process failed with exit code ${code}`;
                console.error(`[Worker] Job ${job.id} execution failed:`, errorDetails);
                await finalizeFailure(job.id, job.profile_id, job.job_cost, errorDetails);
                await cleanUpJobDirectory(jobDir);
                console.log(`${'='.repeat(70)}\n`);
                return;
            }

            // ─── SUCCESS PATH ─────────────────────────────────────────────────
            try {
                console.log(`[Worker] Compiling outputs to zip...`);
                await zipDirectory(outputDir, zipFileLocation);
                console.log(`[Worker] Zip created: ${zipFileLocation}`);

                const relativeZipDownloadPath = `/downloads/${job.id}/colorized_sequence.zip`;
                await finalizeSuccess(
                    job.id,
                    job.profile_id,
                    job.job_cost,
                    relativeZipDownloadPath,
                    elapsedMs
                );

                console.log(`[Worker] Privacy purge: deleting transient files...`);
                await fs.rm(framesDir,    { recursive: true, force: true }).catch(() => {});
                await fs.rm(outputDir,    { recursive: true, force: true }).catch(() => {});
                await fs.rm(refImagePath, { force: true }).catch(() => {});

                console.log(`[Worker] Job ${job.id} completed successfully.`);
                console.log(`${'='.repeat(70)}\n`);

            } catch (zipError: any) {
                console.error(`[Worker] Zip creation failed:`, zipError);
                await finalizeFailure(
                    job.id,
                    job.profile_id,
                    job.job_cost,
                    `Packaging failure: ${zipError?.message}`
                );
                await cleanUpJobDirectory(jobDir);
                console.log(`${'='.repeat(70)}\n`);
            }
        });

    } catch (error: any) {
        console.error(`[Worker] Unexpected loop exception on job ${job.id}:`, error);
        await finalizeFailure(
            job.id,
            job.profile_id,
            job.job_cost,
            error?.message || 'Unexpected worker exception'
        );
        await cleanUpJobDirectory(jobDir);
        console.log('======================================================================\n');
    }
}

/**
 * Clean up helper to ensure zero lingering disk footprint.
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