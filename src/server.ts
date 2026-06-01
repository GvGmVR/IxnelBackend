// server.ts

import 'dotenv/config';
import express    from 'express';
import cors       from 'cors';
import helmet     from 'helmet';
import rateLimit  from 'express-rate-limit';
import path       from 'path';
import fs         from 'fs';

// ─── Route Imports ────────────────────────────────────────────────────────────
import healthRoutes  from './routes/health.routes';
import authRoutes    from './routes/auth.routes';
import profileRoutes from './routes/profile.routes';
import jobRoutes     from './routes/jobs.routes';
import creditRoutes  from './routes/credits.routes';
import paymentRoutes from './routes/payments.routes';

// ─── Middleware Imports ───────────────────────────────────────────────────────
import { errorHandler }  from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';

// ─── DB Import (for startup check) ───────────────────────────────────────────
import { pool } from './config/db';

// ─────────────────────────────────────────────────────────────────────────────
// STEP 0: Environment variable guard
// Fail immediately at startup if critical vars are missing
// Prevents silent failures deep inside controllers
// ─────────────────────────────────────────────────────────────────────────────
const REQUIRED_ENV_VARS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'FRONTEND_URL',
] as const;

const checkRequiredEnvVars = (): void => {
  const missing = REQUIRED_ENV_VARS.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(key => console.error(`   - ${key}`));
    process.exit(1);
  }

  console.log('✅ Environment variables verified');
};

// ─────────────────────────────────────────────────────────────────────────────
// APP SETUP
// ─────────────────────────────────────────────────────────────────────────────
const app = express();

// ─── Trust Proxy ──────────────────────────────────────────────────────────────
app.set('trust proxy', 1);

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: false,
}));

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost',      // Added to support Vite port 80 [1.1.4, 1.2.4]
  'http://localhost:80',   // Added to support Vite port 80 [1.1.4, 1.2.4]
  'http://localhost:5173',
  'http://localhost:3000',
  
].filter(Boolean) as string[];

app.use(cors({
  origin: (
    origin   : string | undefined,
    callback : (err: Error | null, allow?: boolean) => void,
  ) => {
    // Allow REST clients / mobile / curl (no origin header)
    if (!origin) return callback(null, true);

    const isNgrok = origin.endsWith('.ngrok-free.dev');

    if (allowedOrigins.includes(origin)|| isNgrok) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked origin: ${origin}`);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
}));

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITERS
// Each route group has its own limiter — no double-limiting
// ─────────────────────────────────────────────────────────────────────────────

const generalLimiter = rateLimit({
  windowMs : 15 * 60 * 1000,  // 15 minutes
  max      : 100,
  message  : { success: false, error: 'Too many requests, please try again later.' },
});

// Auth is stricter — brute force protection on login/register
const authLimiter = rateLimit({
  windowMs : 15 * 60 * 1000,  // 15 minutes
  max      : 20,
  message  : { success: false, error: 'Too many auth attempts, please try again later.' },
});

// Job submission — per minute, per IP
const jobLimiter = rateLimit({
  windowMs : 60 * 1000,        // 1 minute
  max      : 10,
  message  : { success: false, error: 'Job submission limit reached, slow down.' },
});

// ─── Body Parsing ─────────────────────────────────────────────────────────────
// Must come AFTER rate limiting — no point parsing body of rejected requests
app.use(express.json({ 
  limit: '10mb',
  // Captures the raw body buffer before it gets parsed into an object
  verify: (req: any, _res, buf) => {
    if (req.originalUrl?.includes('/webhook/paddle')) {
      req.rawBody = buf; // Attaches the unmodified Buffer directly to the request
    }
  }
}));
app.use(express.urlencoded({ extended: true }));

// ─── Request Logger (non-production only) ────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use(requestLogger);
}

// ─── Static / Uploads ─────────────────────────────────────────────────────────
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// Each route group gets its own limiter — no double-limiting on auth
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api/health',   generalLimiter, healthRoutes);
app.use('/api/auth',     authLimiter,    authRoutes);    // ← auth only has authLimiter
app.use('/api/profile',  generalLimiter, profileRoutes);
app.use('/api/jobs',     jobLimiter,     jobRoutes);     // ← jobs only has jobLimiter
app.use('/api/credits',  generalLimiter, creditRoutes);
app.use('/api/payments', generalLimiter, paymentRoutes);

// ─── Root ─────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.send('<h1>IXNEL API is LIVE</h1><p>Visit /api/health for status.</p>');
});

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({
    success : false,
    error   : 'Route not found',
  });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use(errorHandler);

// ─────────────────────────────────────────────────────────────────────────────
// SERVER STARTUP
// Order: env check → db check → listen
// If any step fails, process exits — no zombie server accepting requests
// ─────────────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '5000', 10);

const startServer = async (): Promise<void> => {
  try {

    // ── Step 1: Env vars ───────────────────────────────────────────────────
    checkRequiredEnvVars();

    // ── Step 2: DB connection ──────────────────────────────────────────────
    console.log('🔌 Verifying database connection...');
    const dbClient = await pool.connect();
    await dbClient.query('SELECT 1');
    dbClient.release();
    console.log('✅ Database connection verified');

    // ── Step 3: Start listening ────────────────────────────────────────────
    app.listen(PORT, () => {
      console.log(`🚀 IXNEL API running       → http://localhost:${PORT}`);
      console.log(`📡 CORS allowed origins    → ${allowedOrigins.join(', ')}`);
      console.log(`🌍 Environment             → ${process.env.NODE_ENV || 'development'}`);
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

export default app;