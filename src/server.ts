import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';

// ─── Route Imports ────────────────────────────────────────────────────────────
import healthRoutes    from './routes/health.routes';
import authRoutes      from './routes/auth.routes';
import profileRoutes   from './routes/profile.routes';
import jobRoutes       from './routes/jobs.routes';
import creditRoutes    from './routes/credits.routes';
import paymentRoutes   from './routes/payments.routes';
import adminRoutes     from './routes/admin.routes';

// ─── Middleware Imports ───────────────────────────────────────────────────────
import { errorHandler }   from './middleware/errorHandler';
import { requestLogger }  from './middleware/requestLogger';

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
  'http://localhost:5173',
  'http://localhost:3000',
].filter(Boolean) as string[];

app.use(cors({
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => {
    // Allow REST clients / mobile / curl (no origin)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
}));

// ─── Rate Limiting ────────────────────────────────────────────────────────────

// General API limiter
const generalLimiter = rateLimit({
  windowMs : 15 * 60 * 1000,   // 15 minutes
  max      : 100,
  message  : {
    success : false,
    error   : 'Too many requests, please try again later.'
  },
});

// Stricter limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs : 15 * 60 * 1000,   // 15 minutes
  max      : 20,
  message  : {
    success : false,
    error   : 'Too many auth attempts, please try again later.'
  },
});

// Job submission limiter
const jobLimiter = rateLimit({
  windowMs : 60 * 1000,         // 1 minute
  max      : 10,
  message  : {
    success : false,
    error   : 'Job submission limit reached, slow down.'
  },
});

app.use('/api/', generalLimiter);

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Request Logger (dev) ─────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use(requestLogger);
}

// ─── Static / Uploads ─────────────────────────────────────────────────────────
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/health',    healthRoutes);
app.use('/api/auth',      authLimiter, authRoutes);
app.use('/api/profile',   profileRoutes);
app.use('/api/jobs',      jobLimiter,  jobRoutes);
app.use('/api/credits',   creditRoutes);
app.use('/api/payments',  paymentRoutes);
app.use('/api/admin',     adminRoutes);

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

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '5000', 10);

const startServer = async () => {
  try {
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