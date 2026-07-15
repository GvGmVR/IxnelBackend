// src/workers/colorization_worker.ts
import { pool } from '../config/db';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';

const AdmZip = require('adm-zip') as any;

// High-performance image processor
let sharp: any = null;
try {
    sharp = require('sharp');
    console.log('[Worker] sharp image compressor loaded successfully.');
} catch (e) {
    console.warn('[Worker] sharp library not found. Run "npm install sharp" to compress payloads and avoid RunPod 10MB limit errors.');
}

const DISPATCH_INTERVAL_MS = 2000;
const POLL_INTERVAL_MS = 5000; // Check active RunPod jobs every 5 seconds

/**
 * Queries and updates the oldest queued job in a thread-safe database transaction.
 */
async function fetchAndLockQueuedJob() {
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
        console.error('[Worker] Error locking queued job:', error);
        return null;
    } finally {
        client.release();
    }
}

/**
 * Dispatches the queued job to your active RunPod Serverless GPU Endpoint.
 * Downscales inputs on-the-fly to prevent RunPod 10MB gateway blocks [1].
 */
async function dispatchJobToRunPod(job: any) {
    const jobDir = job.input_path;
    const framesDir = path.join(jobDir, 'frames');

    console.log('\n======================================================================');
    console.log(`[Worker] Job ID ${job.id} - DISPATCHING TO RUNPOD CLOUD`);
    console.log(`[Worker] Local Workspace : ${jobDir}`);
    console.log('======================================================================\n');

    let refImageName = 'reference.png';
    try {
        const filesInDir = await fs.readdir(jobDir);
        const refFile = filesInDir.find(f => f.startsWith('reference.'));
        if (refFile) refImageName = refFile;
    } catch (err) {
        console.warn('[Worker] Directory read warning locating reference image:', err);
    }
    const refImagePath = path.join(jobDir, refImageName);

    try {
        const updateResult = await pool.query(
            `UPDATE jobs SET status = 'processing' WHERE id = $1 AND status = 'initiated' RETURNING status;`,
            [job.id]
        );

        if (updateResult.rowCount === 0) {
            console.log(`[Worker] Job ${job.id} status changed (possibly cancelled). Aborting dispatch.`);
            return;
        }

        let origWidth = 512;
        let origHeight = 320;

        // ─── RESOLUTION PRESERVATION: Read & Cache Original Dimensions [1] ───
        if (sharp) {
            try {
                const frameFiles = await fs.readdir(framesDir);
                const firstImage = frameFiles.find(f => ['.png', '.jpg', '.jpeg'].includes(path.extname(f).toLowerCase()));
                if (firstImage) {
                    const meta = await sharp(path.join(framesDir, firstImage)).metadata();
                    origWidth = meta.width || 512;
                    origHeight = meta.height || 320;
                    console.log(`[Worker] Cached source dimensions: ${origWidth}x${origHeight} for restoration.`);
                }
            } catch (metaErr: any) {
                console.warn('[Worker] Failed to read source image dimensions:', metaErr.message);
            }

            // Write metadata locally so the Polling daemon can retrieve it on completion [1]
            const metaPath = path.join(jobDir, 'original_meta.json');
            await fs.writeFile(metaPath, JSON.stringify({ origWidth, origHeight }));

            // ─── Downscale payloads to 512x320 to bypass RunPod 10MB limits [1] ───
            console.log('[Worker] Downscaling inputs to 512x320 for transmission...');
            
            // 1. Downscale reference image
            try {
                const refTempPath = refImagePath + '.tmp';
                await sharp(refImagePath)
                    .resize(512, 320, { fit: 'fill' })
                    .jpeg({ quality: 80 })
                    .toFile(refTempPath);
                await fs.unlink(refImagePath);
                await fs.rename(refTempPath, refImagePath);
            } catch (refErr: any) {
                console.warn('[Worker] Reference image compression failed:', refErr.message);
            }

            // 2. Downscale frames
            try {
                const frameFiles = await fs.readdir(framesDir);
                for (const file of frameFiles) {
                    const ext = path.extname(file).toLowerCase();
                    if (['.png', '.jpg', '.jpeg'].includes(ext)) {
                        const framePath = path.join(framesDir, file);
                        const tempPath = framePath + '.tmp';
                        await sharp(framePath)
                            .resize(512, 320, { fit: 'fill' })
                            .jpeg({ quality: 80 })
                            .toFile(tempPath);
                        await fs.unlink(framePath);
                        await fs.rename(tempPath, framePath);
                    }
                }
            } catch (frameErr: any) {
                console.warn('[Worker] Frame compression failed:', frameErr.message);
            }
        }

        // Package frames and frame_mapping.json directly into an in-memory base64 ZIP payload
        const zip = new AdmZip();
        zip.addLocalFolder(framesDir);

        const mappingPath = path.join(jobDir, 'frame_mapping.json');
        if (fsSync.existsSync(mappingPath)) {
            zip.addLocalFile(mappingPath);
        }

        const zipBuffer = zip.toBuffer();
        const lineartZipB64 = zipBuffer.toString('base64');

        const refBuffer = await fs.readFile(refImagePath);
        const refImageB64 = refBuffer.toString('base64');

        const runpodApiKey = process.env.RUNPOD_API_KEY;
        const runpodEndpointId = process.env.RUNPOD_ENDPOINT_ID;

        if (!runpodApiKey || !runpodEndpointId) {
            throw new Error('RUNPOD_API_KEY or RUNPOD_ENDPOINT_ID environment variables are missing.');
        }

        const response = await fetch(`https://api.runpod.ai/v2/${runpodEndpointId}/run`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${runpodApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                input: {
                    lineart_zip_b64: lineartZipB64,
                    ref_image_b64: refImageB64,
                    start_frame: 0,
                    num_frames: 49,
                    width: 512,
                    height: 320,
                    output_fps: 24,
                    guidance_scale: 6.0,
                    inference_steps: 50
                }
            })
        });

        if (!response.ok) {
            throw new Error(`RunPod Ingestion returned status: ${response.status}`);
        }

        const runpodData: any = await response.json();
        const runpodJobId = runpodData.id;

        if (!runpodJobId) {
            throw new Error('Failed to retrieve runpod_job_id from serverless dispatcher.');
        }

        await pool.query(
            `UPDATE jobs SET runpod_job_id = $1 WHERE id = $2;`,
            [runpodJobId, job.id]
        );

        console.log(`[Worker] Job ${job.id} dispatched to RunPod Cloud successfully. RunPod ID: ${runpodJobId}`);

    } catch (error: any) {
        console.error(`[Worker] Failed dispatching job ${job.id} to RunPod:`, error.message);
        await finalizeFailure(job.id, job.profile_id, job.job_cost, `Cloud Dispatch Failure: ${error?.message}`);
        await cleanUpJobDirectory(jobDir);
    }
}

/**
 * Periodically polls RunPod Serverless API status for all active jobs.
 * Restores colorized frames to original dimensions on completion [1].
 */
async function pollActiveRunPodJobs() {
    const query = `
        SELECT id, profile_id, input_path, job_cost, runpod_job_id, started_at
        FROM jobs
        WHERE status IN ('initiated', 'processing') AND runpod_job_id IS NOT NULL;
    `;
    const result = await pool.query(query);
    const activeJobs = result.rows;

    for (const job of activeJobs) {
        const runpodJobId = job.runpod_job_id;
        const runpodApiKey = process.env.RUNPOD_API_KEY;
        const runpodEndpointId = process.env.RUNPOD_ENDPOINT_ID;

        if (!runpodApiKey || !runpodEndpointId) {
            console.error('[Worker] RUNPOD_API_KEY or RUNPOD_ENDPOINT_ID is missing from env variables!');
            continue;
        }

        try {
            const statusUrl = `https://api.runpod.ai/v2/${runpodEndpointId}/status/${runpodJobId}`;
            const response = await fetch(statusUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${runpodApiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                console.warn(`[Worker] RunPod status query for job ${job.id} returned status: ${response.status}`);
                continue;
            }

            const data: any = await response.json();
            const status = data.status;

            if (status === 'COMPLETED') {
                const elapsedMs = Date.now() - new Date(job.started_at).getTime();
                
                const runpodResult = data.output; 
                const innerOutput = runpodResult?.output; 
                const zipBase64 = innerOutput?.zip_base64;

                if (runpodResult && runpodResult.status === 'success' && zipBase64) {
                    const rawZipBytes = Buffer.from(zipBase64, 'base64');
                    
                    // Retrieve cached original canvas dimensions [1]
                    let origWidth = 512;
                    let origHeight = 320;
                    const metaPath = path.join(job.input_path, 'original_meta.json');
                    if (fsSync.existsSync(metaPath)) {
                        try {
                            const metaData = JSON.parse(await fs.readFile(metaPath, 'utf8'));
                            origWidth = metaData.origWidth;
                            origHeight = metaData.origHeight;
                        } catch (e) {}
                    }

                    // ─── DECOMPRESSION & HIGH-QUALITY RESTORATION [1] ───
                    console.log(`[Worker] Restoring completed frames to source dimensions: ${origWidth}x${origHeight}...`);
                    
                    const tempExtractDir = path.join(job.input_path, 'runpod_output_extract');
                    await fs.mkdir(tempExtractDir, { recursive: true });

                    const rawZip = new AdmZip(rawZipBytes);
                    rawZip.extractAllTo(tempExtractDir, true);

                    // Resize each frame sequentially using the premium Lanczos-3 kernel [1]
                    const extractedFiles = await fs.readdir(tempExtractDir);
                    for (const file of extractedFiles) {
                        const ext = path.extname(file).toLowerCase();
                        if (['.png', '.jpg', '.jpeg'].includes(ext)) {
                            const filePath = path.join(tempExtractDir, file);
                            const tempPath = filePath + '.tmp';
                            await sharp(filePath)
                                .resize(origWidth, origHeight, { kernel: 'lanczos3', fit: 'fill' })
                                .png({ compressionLevel: 9 }) // Keeps output pristine [1]
                                .toFile(tempPath);
                            await fs.unlink(filePath);
                            await fs.rename(tempPath, filePath);
                        }
                    }

                    // Package upscaled frames back into final colorized_sequence.zip
                    const finalZip = new AdmZip();
                    finalZip.addLocalFolder(tempExtractDir);
                    const finalZipBuffer = finalZip.toBuffer();

                    const zipFileLocation = path.join(job.input_path, 'colorized_sequence.zip');
                    await fs.writeFile(zipFileLocation, finalZipBuffer);

                    // Clean temporary upscaling folders
                    await fs.rm(tempExtractDir, { recursive: true, force: true }).catch(() => {});

                    const relativeZipDownloadPath = `/downloads/${job.id}/colorized_sequence.zip`;
                    await finalizeSuccess(
                        job.id,
                        job.profile_id,
                        job.job_cost,
                        relativeZipDownloadPath,
                        elapsedMs
                    );

                    // Privacy purge: Delete transient frames directory
                    const framesDir = path.join(job.input_path, 'frames');
                    await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
                } else {
                    const failReason = innerOutput?.message || runpodResult?.message || 'RunPod completed but did not return a valid Base64 ZIP payload.';
                    await finalizeFailure(job.id, job.profile_id, job.job_cost, failReason);
                    await cleanUpJobDirectory(job.input_path);
                }
            }
            else if (status === 'FAILED') {
                const errorMsg = data.output?.error || 'RunPod serverless container execution failed.';
                await finalizeFailure(job.id, job.profile_id, job.job_cost, errorMsg);
                await cleanUpJobDirectory(job.input_path);
            } 
            else if (status === 'CANCELLED') {
                await finalizeRunPodCancellation(job.id, job.profile_id, job.job_cost);
                await cleanUpJobDirectory(job.input_path);
            }
            else if (status === 'IN_PROGRESS') {
                await pool.query(
                    `UPDATE jobs SET status = 'processing' WHERE id = $1 AND status = 'initiated';`,
                    [job.id]
                );
            }
        } catch (err: any) {
            console.error(`[Worker] Error polling RunPod job ${job.id}:`, err.message);
        }
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
 * Reverts credit reservations specifically if a RunPod cloud-side cancellation occurred [1].
 */
async function finalizeRunPodCancellation(
    jobId: string,
    profileId: string,
    cost: number
) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            `UPDATE jobs SET status = 'cancelled', completed_at = NOW() WHERE id = $1;`,
            [jobId]
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
                    `Released ${cost} reserved credits due to RunPod cloud cancellation`
                ]
            );
        }

        await client.query('COMMIT');
        console.log(`[Worker] Job ${jobId} cancelled on RunPod. Reserved credits released.`);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[Worker] Failed finalizing cancellation release for job ${jobId}:`, error);
    } finally {
        client.release();
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
    console.log('[Worker] RunPod Serverless Daemon initialized...');

    // Daemon Loop 1: Queued Job Dispatcher (Checks for "queued" and dispatches to RunPod)
    setInterval(async () => {
        try {
            const job = await fetchAndLockQueuedJob();
            if (job) {
                await dispatchJobToRunPod(job);
            }
        } catch (err) {
            console.error('[Worker Dispatcher Error]:', err);
        }
    }, DISPATCH_INTERVAL_MS);

    // Daemon Loop 2: Active Job Poller (Checks active RunPod jobs and writes back outputs)
    setInterval(async () => {
        try {
            await pollActiveRunPodJobs();
        } catch (err) {
            console.error('[Worker Poller Error]:', err);
        }
    }, POLL_INTERVAL_MS);
}

// Spawn the worker loop
startWorker();