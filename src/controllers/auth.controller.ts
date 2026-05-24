import { Request, Response } from 'express';
import bcrypt                from 'bcryptjs';
import { pool }              from '../config/db';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  JwtPayload,
}                            from '../lib/jwt';

// ─────────────────────────────────────────────────────────────────────────────
const SALT_ROUNDS         = 12;
const FREE_SIGNUP_CREDITS = 50;

const deriveUsernameFromEmail = (email: string): string => {
  const prefix = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_');
  const suffix = Math.random().toString(36).substring(2, 6);
  return `${prefix}_${suffix}`.toLowerCase();
};

const buildTokens = (payload: JwtPayload) => ({
  accessToken  : generateAccessToken(payload),
  refreshToken : generateRefreshToken(payload),
});

// =============================================================================
// 1. REGISTER LOCAL
// POST /api/auth/register
//
// REQUEST BODY:
// {
//   email        : string   REQUIRED
//   password     : string   REQUIRED  min 8 chars
//   username     : string   REQUIRED
//   user_type    : string   REQUIRED  "individual" | "company"
//   company_name : string   OPTIONAL  required if user_type = "company"
// }
// =============================================================================
export const registerLocal = async (req: Request, res: Response): Promise<void> => {
  const client = await pool.connect();

  try {
    const {
      email,
      password,
      username,
      user_type,
      company_name,
    } = req.body;

    // ── Log incoming for debug ─────────────────────────────────────────────
    console.log('[registerLocal] body:', {
      email,
      username,
      user_type,
      company_name,
      password: password ? '***' : undefined,
    });

    // ── Validate required fields ───────────────────────────────────────────
    if (!email || !password || !username || !user_type) {
      res.status(400).json({
        success : false,
        error   : `Missing required fields. Received: email=${!!email}, password=${!!password}, username=${!!username}, user_type=${!!user_type}`,
      });
      return;
    }

    if (!['individual', 'company'].includes(user_type)) {
      res.status(400).json({
        success : false,
        error   : 'user_type must be individual or company',
      });
      return;
    }

    if (user_type === 'company' && !company_name) {
      res.status(400).json({
        success : false,
        error   : 'company_name is required for company accounts',
      });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({
        success : false,
        error   : 'Password must be at least 8 characters',
      });
      return;
    }

    // ── Begin transaction ──────────────────────────────────────────────────
    await client.query('BEGIN');

    // ── Check email uniqueness ─────────────────────────────────────────────
    const emailCheck = await client.query(
      `SELECT id FROM auth_users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    if (emailCheck.rowCount && emailCheck.rowCount > 0) {
      await client.query('ROLLBACK');
      res.status(409).json({
        success : false,
        error   : 'An account with this email already exists',
      });
      return;
    }

    // ── Check username uniqueness ──────────────────────────────────────────
    const usernameCheck = await client.query(
      `SELECT id FROM profiles WHERE username = $1`,
      [username.trim()]
    );

    if (usernameCheck.rowCount && usernameCheck.rowCount > 0) {
      await client.query('ROLLBACK');
      res.status(409).json({
        success : false,
        error   : 'Username is already taken',
      });
      return;
    }

    // ── Hash password ──────────────────────────────────────────────────────
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

    // ── INSERT auth_users ──────────────────────────────────────────────────
    const authResult = await client.query(
      `INSERT INTO auth_users
        (email, password_hash, auth_provider, email_verified)
       VALUES ($1, $2, 'local', false)
       RETURNING id`,
      [email.toLowerCase().trim(), password_hash]
    );

    const auth_user_id: string = authResult.rows[0].id;

    // ── INSERT profiles ────────────────────────────────────────────────────
    const profileResult = await client.query(
      `INSERT INTO profiles
        (auth_user_id, username, user_type, company_name,
         credits, reserved_credits, total_credits_used, is_blocked)
       VALUES ($1, $2, $3, $4, $5, 0, 0, false)
       RETURNING id, username, user_type, company_name, credits`,
      [
        auth_user_id,
        username.trim(),
        user_type,
        user_type === 'company' ? company_name.trim() : null,
        FREE_SIGNUP_CREDITS,
      ]
    );

    const profile = profileResult.rows[0];

    // ── INSERT credit_transactions (free_grant) ────────────────────────────
    await client.query(
      `INSERT INTO credit_transactions
        (profile_id, transaction_type, amount, balance_after, notes)
       VALUES ($1, 'free_grant', $2, $2, 'Welcome bonus credits on signup')`,
      [profile.id, FREE_SIGNUP_CREDITS]
    );

    await client.query('COMMIT');

    // ── Build tokens ───────────────────────────────────────────────────────
    const tokenPayload: JwtPayload = {
      auth_user_id,
      profile_id : profile.id,
      email      : email.toLowerCase().trim(),
    };

    const { accessToken, refreshToken } = buildTokens(tokenPayload);

    console.log('[registerLocal] success for:', email);

    res.status(201).json({
      success      : true,
      accessToken,
      refreshToken,
      user : {
        id             : auth_user_id,
        email          : email.toLowerCase().trim(),
        name           : profile.username,
        auth_provider  : 'local',
        email_verified : false,
      },
      profile : {
        id                : profile.id,
        username          : profile.username,
        user_type         : profile.user_type,
        company_name      : profile.company_name,
        credits           : profile.credits,
        reserved_credits  : 0,
        available_credits : profile.credits,
        is_blocked        : false,
      },
    });

  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('[registerLocal] error:', error);
    res.status(500).json({
      success : false,
      error   : 'Internal server error during registration',
      ...(process.env.NODE_ENV !== 'production' && { detail: error.message }),
    });
  } finally {
    client.release();
  }
};

// =============================================================================
// 2. LOGIN LOCAL
// POST /api/auth/login
//
// REQUEST BODY:
// {
//   email    : string   REQUIRED
//   password : string   REQUIRED
// }
// =============================================================================
export const loginLocal = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    console.log('[loginLocal] attempt for:', email);

    if (!email || !password) {
      res.status(400).json({
        success : false,
        error   : 'email and password are required',
      });
      return;
    }

    // ── Fetch auth user ────────────────────────────────────────────────────
    const authResult = await pool.query(
      `SELECT id, email, password_hash, auth_provider, email_verified
       FROM auth_users
       WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    if (!authResult.rowCount || authResult.rowCount === 0) {
      res.status(401).json({
        success : false,
        error   : 'Invalid email or password',
      });
      return;
    }

    const authUser = authResult.rows[0];

    if (authUser.auth_provider !== 'local') {
      res.status(400).json({
        success : false,
        error   : `This account uses ${authUser.auth_provider} login. Please use that instead.`,
      });
      return;
    }

    // ── Verify password ────────────────────────────────────────────────────
    const passwordMatch = await bcrypt.compare(password, authUser.password_hash);

    if (!passwordMatch) {
      res.status(401).json({
        success : false,
        error   : 'Invalid email or password',
      });
      return;
    }

    // ── Fetch profile ──────────────────────────────────────────────────────
    const profileResult = await pool.query(
      `SELECT id, username, user_type, company_name,
              credits, reserved_credits, is_blocked
       FROM profiles
       WHERE auth_user_id = $1`,
      [authUser.id]
    );

    const profile = profileResult.rows[0];

    if (profile.is_blocked) {
      res.status(403).json({
        success : false,
        error   : 'Your account has been suspended. Contact support.',
      });
      return;
    }

    // ── Build tokens ───────────────────────────────────────────────────────
    const tokenPayload: JwtPayload = {
      auth_user_id : authUser.id,
      profile_id   : profile.id,
      email        : authUser.email,
    };

    const { accessToken, refreshToken } = buildTokens(tokenPayload);

    console.log('[loginLocal] success for:', email);

    res.status(200).json({
      success      : true,
      accessToken,
      refreshToken,
      user : {
        id             : profile.id,
        email          : authUser.email,
        name           : profile.username,
        auth_provider  : authUser.auth_provider,
        email_verified : authUser.email_verified,
      },
      profile : {
        id                : profile.id,
        username          : profile.username,
        user_type         : profile.user_type,
        company_name      : profile.company_name,
        credits           : profile.credits,
        reserved_credits  : profile.reserved_credits,
        available_credits : profile.credits - profile.reserved_credits,
        is_blocked        : profile.is_blocked,
      },
    });

  } catch (error: any) {
    console.error('[loginLocal] error:', error);
    res.status(500).json({
      success : false,
      error   : 'Internal server error during login',
      ...(process.env.NODE_ENV !== 'production' && { detail: error.message }),
    });
  }
};

// =============================================================================
// 3. OAUTH CALLBACK
// POST /api/auth/oauth/callback
//
// REQUEST BODY:
// {
//   provider         : "google" | "github"   REQUIRED
//   provider_user_id : string                REQUIRED
//   email            : string                REQUIRED
//   user_type        : "individual"|"company" REQUIRED (new users only)
//   company_name     : string                OPTIONAL
// }
// =============================================================================
export const oauthCallback = async (req: Request, res: Response): Promise<void> => {
  const client = await pool.connect();

  try {
    const {
      provider,
      provider_user_id,
      email,
      user_type,
      company_name,
    } = req.body;

    console.log('[oauthCallback] body:', { provider, email, user_type });

    if (!provider || !provider_user_id || !email) {
      res.status(400).json({
        success : false,
        error   : 'provider, provider_user_id and email are required',
      });
      return;
    }

    if (!['google', 'github'].includes(provider)) {
      res.status(400).json({
        success : false,
        error   : 'provider must be google or github',
      });
      return;
    }

    await client.query('BEGIN');

    // ── Check existing OAuth user ──────────────────────────────────────────
    const existingAuth = await client.query(
      `SELECT id FROM auth_users
       WHERE auth_provider = $1 AND provider_user_id = $2`,
      [provider, provider_user_id]
    );

    let auth_user_id: string;
    let isNewUser = false;

    if (existingAuth.rowCount && existingAuth.rowCount > 0) {
      // ── Returning user ─────────────────────────────────────────────────
      auth_user_id = existingAuth.rows[0].id;

    } else {
      // ── New OAuth user ─────────────────────────────────────────────────
      if (!user_type || !['individual', 'company'].includes(user_type)) {
        await client.query('ROLLBACK');
        res.status(400).json({
          success : false,
          error   : 'user_type is required for new OAuth users',
        });
        return;
      }

      if (user_type === 'company' && !company_name) {
        await client.query('ROLLBACK');
        res.status(400).json({
          success : false,
          error   : 'company_name is required for company accounts',
        });
        return;
      }

      // ── Check email not already used ───────────────────────────────────
      const emailCheck = await client.query(
        `SELECT id, auth_provider FROM auth_users WHERE email = $1`,
        [email.toLowerCase().trim()]
      );

      if (emailCheck.rowCount && emailCheck.rowCount > 0) {
        await client.query('ROLLBACK');
        res.status(409).json({
          success : false,
          error   : `Email already registered via ${emailCheck.rows[0].auth_provider}`,
        });
        return;
      }

      // ── INSERT auth_users ──────────────────────────────────────────────
      const authInsert = await client.query(
        `INSERT INTO auth_users
          (email, password_hash, auth_provider, provider_user_id, email_verified)
         VALUES ($1, NULL, $2, $3, true)
         RETURNING id`,
        [email.toLowerCase().trim(), provider, provider_user_id]
      );

      auth_user_id = authInsert.rows[0].id;

      // ── Derive unique username ─────────────────────────────────────────
      let username = deriveUsernameFromEmail(email);
      for (let i = 0; i < 5; i++) {
        const check = await client.query(
          `SELECT id FROM profiles WHERE username = $1`, [username]
        );
        if (!check.rowCount || check.rowCount === 0) break;
        username = deriveUsernameFromEmail(email);
      }

      // ── INSERT profiles ────────────────────────────────────────────────
      const profileInsert = await client.query(
        `INSERT INTO profiles
          (auth_user_id, username, user_type, company_name,
           credits, reserved_credits, total_credits_used, is_blocked)
         VALUES ($1, $2, $3, $4, $5, 0, 0, false)
         RETURNING id`,
        [
          auth_user_id,
          username,
          user_type,
          user_type === 'company' ? company_name.trim() : null,
          FREE_SIGNUP_CREDITS,
        ]
      );

      // ── INSERT free_grant ──────────────────────────────────────────────
      await client.query(
        `INSERT INTO credit_transactions
          (profile_id, transaction_type, amount, balance_after, notes)
         VALUES ($1, 'free_grant', $2, $2, 'Welcome bonus on OAuth signup')`,
        [profileInsert.rows[0].id, FREE_SIGNUP_CREDITS]
      );

      isNewUser = true;
    }

    await client.query('COMMIT');

    // ── Fetch profile for response ─────────────────────────────────────────
    const profileResult = await pool.query(
      `SELECT id, username, user_type, company_name,
              credits, reserved_credits, is_blocked
       FROM profiles WHERE auth_user_id = $1`,
      [auth_user_id]
    );

    const profile = profileResult.rows[0];

    if (profile.is_blocked) {
      res.status(403).json({ success: false, error: 'Account suspended' });
      return;
    }

    const tokenPayload: JwtPayload = {
      auth_user_id,
      profile_id : profile.id,
      email      : email.toLowerCase().trim(),
    };

    const { accessToken, refreshToken } = buildTokens(tokenPayload);

    res.status(isNewUser ? 201 : 200).json({
      success   : true,
      isNewUser,
      accessToken,
      refreshToken,
      user : {
        id             : profile.id,
        email          : email.toLowerCase().trim(),
        name           : profile.username,
        auth_provider  : provider,
        email_verified : true,
      },
      profile : {
        id                : profile.id,
        username          : profile.username,
        user_type         : profile.user_type,
        company_name      : profile.company_name,
        credits           : profile.credits,
        reserved_credits  : profile.reserved_credits,
        available_credits : profile.credits - profile.reserved_credits,
        is_blocked        : profile.is_blocked,
      },
    });

  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('[oauthCallback] error:', error);
    res.status(500).json({
      success : false,
      error   : 'Internal server error during OAuth',
      ...(process.env.NODE_ENV !== 'production' && { detail: error.message }),
    });
  } finally {
    client.release();
  }
};

// =============================================================================
// 4. VERIFY EMAIL
// GET /api/auth/verify-email?token=xxx
// =============================================================================
export const verifyEmail = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token } = req.query;

    if (!token || typeof token !== 'string') {
      res.status(400).json({ success: false, error: 'Token is required' });
      return;
    }

    let decoded: any;
    try {
      const jwt = await import('jsonwebtoken');
      decoded   = jwt.default.verify(token, process.env.JWT_ACCESS_SECRET as string);
    } catch {
      res.status(400).json({ success: false, error: 'Invalid or expired token' });
      return;
    }

    if (decoded.purpose !== 'email_verify') {
      res.status(400).json({ success: false, error: 'Invalid token purpose' });
      return;
    }

    await pool.query(
      `UPDATE auth_users SET email_verified = true, updated_at = NOW() WHERE id = $1`,
      [decoded.auth_user_id]
    );

    res.status(200).json({ success: true, message: 'Email verified successfully' });

  } catch (error: any) {
    console.error('[verifyEmail] error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// =============================================================================
// 5. FORGOT PASSWORD
// POST /api/auth/forgot-password
//
// REQUEST BODY:
// {
//   email : string   REQUIRED
// }
// =============================================================================
export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({ success: false, error: 'email is required' });
      return;
    }

    const safeResponse = () => res.status(200).json({
      success : true,
      message : 'If that email exists, a reset link has been sent.',
    });

    const result = await pool.query(
      `SELECT id, auth_provider FROM auth_users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    if (!result.rowCount || result.rowCount === 0) { safeResponse(); return;}
    if (result.rows[0].auth_provider !== 'local')  { safeResponse(); return; }

    const jwt       = await import('jsonwebtoken');
    const resetToken = jwt.default.sign(
      { auth_user_id: result.rows[0].id, purpose: 'password_reset' },
      process.env.JWT_ACCESS_SECRET as string,
      { expiresIn: '15m' }
    );

    // TODO: plug in mailer service
    console.log(`[DEV] Reset token for ${email}: ${resetToken}`);

    safeResponse();

  } catch (error: any) {
    console.error('[forgotPassword] error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// =============================================================================
// 6. RESET PASSWORD
// POST /api/auth/reset-password
//
// REQUEST BODY:
// {
//   token       : string   REQUIRED
//   newPassword : string   REQUIRED  min 8 chars
// }
// =============================================================================
export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      res.status(400).json({ success: false, error: 'token and newPassword are required' });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
      return;
    }

    let decoded: any;
    try {
      const jwt = await import('jsonwebtoken');
      decoded   = jwt.default.verify(token, process.env.JWT_ACCESS_SECRET as string);
    } catch {
      res.status(400).json({ success: false, error: 'Invalid or expired reset token' });
      return;
    }

    if (decoded.purpose !== 'password_reset') {
      res.status(400).json({ success: false, error: 'Invalid token purpose' });
      return;
    }

    const password_hash = await bcrypt.hash(newPassword, SALT_ROUNDS);

    await pool.query(
      `UPDATE auth_users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [password_hash, decoded.auth_user_id]
    );

    res.status(200).json({ success: true, message: 'Password reset successfully' });

  } catch (error: any) {
    console.error('[resetPassword] error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// =============================================================================
// 7. REFRESH TOKEN
// POST /api/auth/refresh
//
// REQUEST BODY:
// {
//   refreshToken : string   REQUIRED
// }
// =============================================================================
export const refreshToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const { refreshToken: token } = req.body;

    if (!token) {
      res.status(400).json({ success: false, error: 'refreshToken is required' });
      return;
    }

    let decoded: JwtPayload;
    try {
      decoded = verifyRefreshToken(token);
    } catch {
      res.status(401).json({ success: false, error: 'Invalid or expired refresh token' });
      return;
    }

    const profileResult = await pool.query(
      `SELECT id, is_blocked FROM profiles WHERE id = $1`,
      [decoded.profile_id]
    );

    if (!profileResult.rowCount || profileResult.rowCount === 0) {
      res.status(401).json({ success: false, error: 'User not found' });
      return;
    }

    if (profileResult.rows[0].is_blocked) {
      res.status(403).json({ success: false, error: 'Account suspended' });
      return;
    }

    const { accessToken, refreshToken: newRefreshToken } = buildTokens({
      auth_user_id : decoded.auth_user_id,
      profile_id   : decoded.profile_id,
      email        : decoded.email,
    });

    res.status(200).json({
      success      : true,
      accessToken,
      refreshToken : newRefreshToken,
    });

  } catch (error: any) {
    console.error('[refreshToken] error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// =============================================================================
// 8. LOGOUT
// POST /api/auth/logout
// Protected - requireAuth middleware runs first
// =============================================================================
export const logout = async (_req: Request, res: Response): Promise<void> => {
  try {
    // Stateless JWT logout
    // TODO: Add Redis blacklist when Redis is integrated
    res.status(200).json({
      success : true,
      message : 'Logged out successfully',
    });
  } catch (error: any) {
    console.error('[logout] error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// =============================================================================
// 9. GET ME
// GET /api/auth/me
// Protected - requireAuth middleware runs first
// =============================================================================
export const getMe = async (req: Request, res: Response): Promise<void> => {
  try {
    const { auth_user_id, profile_id } = req.user!;

    const authResult = await pool.query(
      `SELECT id, email, auth_provider, email_verified
       FROM auth_users WHERE id = $1`,
      [auth_user_id]
    );

    if (!authResult.rowCount || authResult.rowCount === 0) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const authUser = authResult.rows[0];

    const profileResult = await pool.query(
      `SELECT id, username, user_type, company_name,
              credits, reserved_credits, total_credits_used, is_blocked
       FROM profiles WHERE id = $1`,
      [profile_id]
    );

    const profile = profileResult.rows[0];

    if (profile.is_blocked) {
      res.status(403).json({ success: false, error: 'Account suspended' });
      return;
    }

    res.status(200).json({
      success : true,
      user : {
        id             : profile.id,
        email          : authUser.email,
        name           : profile.username,
        auth_provider  : authUser.auth_provider,
        email_verified : authUser.email_verified,
      },
      profile : {
        id                 : profile.id,
        username           : profile.username,
        user_type          : profile.user_type,
        company_name       : profile.company_name,
        credits            : profile.credits,
        reserved_credits   : profile.reserved_credits,
        available_credits  : profile.credits - profile.reserved_credits,
        total_credits_used : profile.total_credits_used,
        is_blocked         : profile.is_blocked,
      },
    });

  } catch (error: any) {
    console.error('[getMe] error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};