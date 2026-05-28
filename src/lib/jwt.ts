import jwt, { SignOptions, Secret } from 'jsonwebtoken';

// ─────────────────────────────────────────────────────────────────────────────
// Token payload shape attached to every request after auth
// ─────────────────────────────────────────────────────────────────────────────
export interface JwtPayload {
  auth_user_id : string;   // UUID from auth_users.id
  profile_id   : string;   // UUID from profiles.id
  email        : string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Secrets - typed as Secret to satisfy jsonwebtoken
// Make environment variables optional for development
// ─────────────────────────────────────────────────────────────────────────────


const ACCESS_SECRET  : Secret = process.env.JWT_ACCESS_SECRET  || 'dev-access-secret';
const REFRESH_SECRET : Secret = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret';

// ─────────────────────────────────────────────────────────────────────────────
// Expiries - cast through unknown to satisfy strict StringValue type
// (jsonwebtoken's StringValue is internal & not exported, so we use a cast)
// ─────────────────────────────────────────────────────────────────────────────
const ACCESS_EXPIRES_IN  = (process.env.JWT_ACCESS_EXPIRES_IN  || '15m') as SignOptions['expiresIn'];
const REFRESH_EXPIRES_IN = (process.env.JWT_REFRESH_EXPIRES_IN || '7d')  as SignOptions['expiresIn'];

// ─────────────────────────────────────────────────────────────────────────────

// Sanity check at boot - fail fast if secrets are missing in PROD only
// Allow fallback for development
// ─────────────────────────────────────────────────────────────────────────────

const isDev = process.env.NODE_ENV === 'development';
if (!isDev && (!ACCESS_SECRET || !REFRESH_SECRET)) {
  throw new Error(
    'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be defined in .env'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate short-lived access token (15 min default)
// ─────────────────────────────────────────────────────────────────────────────
export const generateAccessToken = (payload: JwtPayload): string => {
  const options: SignOptions = { expiresIn: ACCESS_EXPIRES_IN };
  return jwt.sign(payload, ACCESS_SECRET, options);
};

// ─────────────────────────────────────────────────────────────────────────────
// Generate long-lived refresh token (7 days default)
// ─────────────────────────────────────────────────────────────────────────────
export const generateRefreshToken = (payload: JwtPayload): string => {
  const options: SignOptions = { expiresIn: REFRESH_EXPIRES_IN };
  return jwt.sign(payload, REFRESH_SECRET, options);
};

// ─────────────────────────────────────────────────────────────────────────────
// Verify access token
// ─────────────────────────────────────────────────────────────────────────────
export const verifyAccessToken = (token: string): JwtPayload => {
  return jwt.verify(token, ACCESS_SECRET) as JwtPayload;
};

// ─────────────────────────────────────────────────────────────────────────────
// Verify refresh token
// ─────────────────────────────────────────────────────────────────────────────
export const verifyRefreshToken = (token: string): JwtPayload => {
  return jwt.verify(token, REFRESH_SECRET) as JwtPayload;
};