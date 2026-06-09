// auth.controller.ts
import { Request, Response } from 'express';
import bcrypt                from 'bcryptjs';
import { PoolClient }        from 'pg';
import { pool }              from '../config/db';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  JwtPayload,
}                            from '../lib/jwt';
import { exchangeGitHubCode } from '../utils/github';
import { emailService } from '../services/email.service';


// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const SALT_ROUNDS         = 12;
const FREE_SIGNUP_CREDITS = 50;
const VALID_PROVIDERS     = ['google', 'github'] as const;
const VALID_USER_TYPES    = ['individual', 'company'] as const;

type AuthProvider = typeof VALID_PROVIDERS[number];
type UserType     = typeof VALID_USER_TYPES[number];

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG LOGGER
// ─────────────────────────────────────────────────────────────────────────────
const debug = {
  info : (fn: string, step: string, data?: unknown) =>
    console.log(`[auth][${fn}][${step}]`, data ?? ''),

  warn : (fn: string, step: string, data?: unknown) =>
    console.warn(`[auth][${fn}][WARN][${step}]`, data ?? ''),

  error: (fn: string, step: string, err: unknown) =>
    console.error(`[auth][${fn}][ERROR][${step}]`, err),
};

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

const buildUserResponse = (row: {
  id             : string;
  email          : string;
  auth_provider  : string;
  email_verified : boolean;
  created_at     : string;
  updated_at     : string;
}) => ({
  id             : row.id,
  email          : row.email,
  auth_provider  : row.auth_provider,
  email_verified : row.email_verified,
  created_at     : row.created_at,
  updated_at     : row.updated_at,
});

const buildProfileResponse = (row: any) => ({
  id                 : row.id,
  auth_user_id       : row.auth_user_id,
  username           : row.username,
  user_type          : row.user_type,
  company_name       : row.company_name,
  credits            : row.current_credit_balance,
  subscription_credits: row.subscription_credits, // Exposes expiring subscription pool [1.2.4]
  purchased_credits  : row.purchased_credits,   // Exposes non-expiring purchased pool [1.2.4]
  reserved_credits   : row.reserved_credits,
  available_credits  : row.current_credit_balance - row.reserved_credits,
  total_credits_used : row.total_credits_used,
  is_blocked         : row.is_blocked,
  created_at         : row.created_at,
  updated_at         : row.updated_at,
});

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const buildTokenPair = (payload: JwtPayload) => ({
  accessToken  : generateAccessToken(payload),
  refreshToken : generateRefreshToken(payload),
});

const buildTokenPayload = (
  auth_user_id: string,
  profile_id: string,
  email: string,
): JwtPayload => ({ auth_user_id, profile_id, email });

// ─────────────────────────────────────────────────────────────────────────────
// USERNAME DERIVATION
// ─────────────────────────────────────────────────────────────────────────────

const deriveUsernameFromEmail = (email: string): string => {
  const prefix = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_');
  const suffix = Math.random().toString(36).substring(2, 6);
  return `${prefix}_${suffix}`.toLowerCase();
};

const findAvailableUsername = async (
  client: PoolClient,
  email: string,
  maxAttempts = 5,
): Promise<string> => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = deriveUsernameFromEmail(email);

    debug.info('findAvailableUsername', `attempt_${attempt}`, { candidate });

    const existing = await client.query(
      `SELECT id FROM profiles WHERE username = $1`,
      [candidate],
    );

    if (!existing.rowCount || existing.rowCount === 0) {
      debug.info('findAvailableUsername', 'found', { candidate });
      return candidate;
    }
  }

  debug.error('findAvailableUsername', 'all_attempts_failed', { email, maxAttempts });
  throw new Error(`Could not derive unique username after ${maxAttempts} attempts`);
};

// ─────────────────────────────────────────────────────────────────────────────
// DB QUERY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const checkEmailExists = async (
  client: PoolClient,
  email: string,
) => {
  debug.info('checkEmailExists', 'querying', { email });

  const result = await client.query(
    `SELECT id, auth_provider FROM auth_users WHERE email = $1`,
    [email],
  );

  debug.info('checkEmailExists', 'result', {
    found    : (result.rowCount ?? 0) > 0,
    provider : result.rows[0]?.auth_provider,
  });

  return result.rows[0] ?? null;
};

const checkUsernameExists = async (
  client: PoolClient,
  username: string,
) => {
  debug.info('checkUsernameExists', 'querying', { username });

  const result = await client.query(
    `SELECT id FROM profiles WHERE username = $1`,
    [username],
  );

  const taken = (result.rowCount ?? 0) > 0;
  debug.info('checkUsernameExists', 'result', { username, taken });
  return taken;
};

const insertAuthUser = async (
  client: PoolClient,
  email: string,
  password_hash: string | null,
  auth_provider: string,
  provider_user_id: string | null,
  email_verified: boolean,
) => {
  debug.info('insertAuthUser', 'inserting', { email, auth_provider, email_verified });

  const result = await client.query(
    `INSERT INTO auth_users
       (email, password_hash, auth_provider, provider_user_id, email_verified)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, auth_provider, email_verified, created_at, updated_at`,
    [email, password_hash, auth_provider, provider_user_id, email_verified],
  );

  debug.info('insertAuthUser', 'success', { id: result.rows[0].id });
  return result.rows[0];
};

// auth.controller.ts (Update these 3 helper functions)

const insertProfile = async (
  client: PoolClient,
  auth_user_id: string,
  username: string,
  user_type: string,
  company_name: string | null,
  initial_credits: number,
) => {
  debug.info('insertProfile', 'inserting', {
    auth_user_id,
    username,
    user_type,
    company_name,
    initial_credits,
  });

  // Safe: Inserts initial welcome credits directly into purchased_credits [1.2.4]
  const result = await client.query(
    `INSERT INTO profiles
       (auth_user_id, username, user_type, company_name,
        current_credit_balance, purchased_credits, subscription_credits,
        reserved_credits, total_credits_used, is_blocked)
     VALUES ($1, $2, $3, $4, $5, $5, 0, 0, 0, false)
     RETURNING
       id, auth_user_id, username, user_type, company_name,
       current_credit_balance, purchased_credits, subscription_credits,
       reserved_credits, total_credits_used,
       is_blocked, created_at, updated_at`,
    [auth_user_id, username, user_type, company_name, initial_credits],
  );

  debug.info('insertProfile', 'success', { id: result.rows[0].id });
  return result.rows[0];
};

// auth.controller.ts (Update these 2 helper queries)

const fetchProfileByAuthUserId = async (
  auth_user_id: string,
) => {
  debug.info('fetchProfileByAuthUserId', 'querying', { auth_user_id });

  // Selects subscription_credits and purchased_credits explicitly [1]
  const result = await pool.query(
    `SELECT
       id, auth_user_id, username, user_type, company_name,
       current_credit_balance, subscription_credits, purchased_credits, reserved_credits, total_credits_used,
       is_blocked, created_at, updated_at
     FROM profiles WHERE auth_user_id = $1`,
    [auth_user_id],
  );

  if (!result.rowCount || result.rowCount === 0) {
    debug.warn('fetchProfileByAuthUserId', 'not_found', { auth_user_id });
    return null;
  }

  debug.info('fetchProfileByAuthUserId', 'found', {
    profile_id : result.rows[0].id,
    is_blocked : result.rows[0].is_blocked,
  });

  return result.rows[0];
};

const fetchProfileById = async (
  profile_id: string,
) => {
  debug.info('fetchProfileById', 'querying', { profile_id });

  // Selects subscription_credits and purchased_credits explicitly [1]
  const result = await pool.query(
    `SELECT
       id, auth_user_id, username, user_type, company_name,
       current_credit_balance, subscription_credits, purchased_credits, reserved_credits, total_credits_used,
       is_blocked, created_at, updated_at
     FROM profiles WHERE id = $1`,
    [profile_id],
  );

  if (!result.rowCount || result.rowCount === 0) {
    debug.warn('fetchProfileById', 'not_found', { profile_id });
    return null;
  }

  debug.info('fetchProfileById', 'found', {
    profile_id,
    is_blocked: result.rows[0].is_blocked,
  });

  return result.rows[0];
};

const insertFreeGrantTransaction = async (
  client: PoolClient,
  profile_id: string,
  amount: number,
  notes: string,
) => {
  debug.info('insertFreeGrantTransaction', 'inserting', { profile_id, amount });

  await client.query(
    `INSERT INTO credit_transactions
       (profile_id, transaction_type, amount, balance_after, notes)
     VALUES ($1, 'free_grant', $2, $2, $3)`,
    [profile_id, amount, notes],
  );

  debug.info('insertFreeGrantTransaction', 'success', { profile_id });
};

const fetchAuthUserById = async (
  id: string,
) => {
  debug.info('fetchAuthUserById', 'querying', { id });

  const result = await pool.query(
    `SELECT id, email, auth_provider, email_verified, created_at, updated_at
     FROM auth_users WHERE id = $1`,
    [id],
  );

  if (!result.rowCount || result.rowCount === 0) {
    debug.warn('fetchAuthUserById', 'not_found', { id });
    return null;
  }

  debug.info('fetchAuthUserById', 'found', { id });
  return result.rows[0];
};

const fetchAuthUserByEmail = async (
  email: string,
) => {
  debug.info('fetchAuthUserByEmail', 'querying', { email });

  const result = await pool.query(
    `SELECT id, email, password_hash, auth_provider, email_verified, created_at, updated_at
     FROM auth_users WHERE email = $1`,
    [email],
  );

  if (!result.rowCount || result.rowCount === 0) {
    debug.warn('fetchAuthUserByEmail', 'not_found', { email });
    return null;
  }

  debug.info('fetchAuthUserByEmail', 'found', { email, provider: result.rows[0].auth_provider });
  return result.rows[0];
};

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATORS
// ─────────────────────────────────────────────────────────────────────────────

const validateRegisterLocalBody = (body: Record<string, unknown>): string | null => {
  const { email, password, username, user_type, company_name } = body;

  if (!email)     return 'email is required';
  if (!password)  return 'password is required';
  if (!username)  return 'username is required';
  if (!user_type) return 'user_type is required';

  if (!VALID_USER_TYPES.includes(user_type as UserType)) {
    return `user_type must be one of: ${VALID_USER_TYPES.join(', ')}`;
  }

  if ((password as string).length < 8) {
    return 'Password must be at least 8 characters';
  }

  // Ensures company names cannot consist solely of whitespace
  if (user_type === 'company' && (!company_name || (company_name as string).trim() === '')) {
    return 'company_name is required for company accounts';
  }

  return null;
};

const validateOAuthCallbackBody = (body: Record<string, unknown>): string | null => {
  const { provider, provider_user_id, email, code } = body;

  if (!provider) return 'provider is required';

  if (!VALID_PROVIDERS.includes(provider as AuthProvider)) {
    return `provider must be one of: ${VALID_PROVIDERS.join(', ')}`;
  }

  if (provider === 'github') {
    if (!code && !provider_user_id) {
      return 'Either code or provider_user_id is required for GitHub OAuth';
    }
    if (provider_user_id && !email) {
      return 'email is required when provider_user_id is provided';
    }
  } else {
    if (!provider_user_id) return 'provider_user_id is required';
    if (!email)            return 'email is required';
  }

  return null;
};

const validateNewOAuthUserBody = (body: Record<string, unknown>): string | null => {
  const { user_type, company_name } = body;

  if (!user_type || !VALID_USER_TYPES.includes(user_type as UserType)) {
    return 'user_type is required for new OAuth users';
  }

  if (user_type === 'company' && (!company_name || (company_name as string).trim() === '')) {
    return 'company_name is required for company accounts';
  }

  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLLERS
// ─────────────────────────────────────────────────────────────────────────────

// =============================================================================
// 1. REGISTER LOCAL
// =============================================================================
export const registerLocal = async (req: Request, res: Response): Promise<void> => {
  const FN = 'registerLocal';
  const client = await pool.connect();

  try {
    debug.info(FN, 'start', { email: req.body.email, user_type: req.body.user_type });

    // ── Step 1: Validate input ──
    const validationError = validateRegisterLocalBody(req.body);
    if (validationError) {
      debug.warn(FN, 'validation_failed', { validationError });
      res.status(400).json({ success: false, error: validationError });
      return;
    }

    const { email, password, username, user_type, company_name } = req.body;
    const normalizedEmail    = (email as string).toLowerCase().trim();
    const normalizedUsername = (username as string).trim();

    // ── Step 2: Begin transaction ──
    debug.info(FN, 'tx_begin');
    await client.query('BEGIN');

    // ── Step 3: Email uniqueness check ──
    const existingEmail = await checkEmailExists(client, normalizedEmail);
    if (existingEmail) {
      debug.warn(FN, 'email_conflict', { normalizedEmail });
      await client.query('ROLLBACK');
      res.status(409).json({ success: false, error: 'An account with this email already exists' });
      return;
    }

    // ── Step 4: Username uniqueness check ──
    const usernameTaken = await checkUsernameExists(client, normalizedUsername);
    if (usernameTaken) {
      debug.warn(FN, 'username_conflict', { normalizedUsername });
      await client.query('ROLLBACK');
      res.status(409).json({ success: false, error: 'Username is already taken' });
      return;
    }

    // ── Step 5: Hash password ──
    debug.info(FN, 'hashing_password');
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

    // ── Step 6: Insert auth user ──
    const authUser = await insertAuthUser(
      client,
      normalizedEmail,
      password_hash,
      'local',
      null,
      false,
    );

    // ── Step 7: Insert profile (Saves 'null' if the account is an individual) ──
    const profile = await insertProfile(
      client,
      authUser.id,
      normalizedUsername,
      user_type,
      user_type === 'company' ? (company_name as string).trim() : null,
      FREE_SIGNUP_CREDITS,
    );

    // ── Step 8: Record free_grant transaction ──
    await insertFreeGrantTransaction(
      client,
      profile.id,
      FREE_SIGNUP_CREDITS,
      'Welcome bonus credits on signup',
    );

    // ── Step 9: Commit ──
    await client.query('COMMIT');
    debug.info(FN, 'tx_committed', { auth_user_id: authUser.id, profile_id: profile.id });

    // ── Step 10: Build and return response ──
    const tokens = buildTokenPair(
      buildTokenPayload(authUser.id, profile.id, authUser.email),
    );

    debug.info(FN, 'success', { email: normalizedEmail });

    res.status(201).json({
      success : true,
      ...tokens,
      user    : buildUserResponse(authUser),
      profile : buildProfileResponse(profile),
    });

  } catch (err) {
    await client.query('ROLLBACK');
    debug.error(FN, 'unhandled_exception', err);

    res.status(500).json({
      success : false,
      error   : 'Internal server error during registration',
      ...(process.env.NODE_ENV !== 'production' && {
        detail: err instanceof Error ? err.message : String(err),
      }),
    });
  } finally {
    client.release();
    debug.info(FN, 'client_released');
  }
};

// =============================================================================
// 2. LOGIN LOCAL
// =============================================================================
export const loginLocal = async (req: Request, res: Response): Promise<void> => {
  const FN = 'loginLocal';

  try {
    const { email, password } = req.body;

    debug.info(FN, 'start', { email });

    // ── Step 1: Validate input ──
    if (!email || !password) {
      debug.warn(FN, 'missing_fields', { hasEmail: !!email, hasPassword: !!password });
      res.status(400).json({ success: false, error: 'email and password are required' });
      return;
    }

    const normalizedEmail = (email as string).toLowerCase().trim();

    // ── Step 2: Fetch auth user ──
    const authUser = await fetchAuthUserByEmail(normalizedEmail);
    if (!authUser) {
      debug.warn(FN, 'email_not_found', { normalizedEmail });
      res.status(401).json({ success: false, error: 'Invalid email or password' });
      return;
    }

    // ── Step 3: Provider check ──
    if (authUser.auth_provider !== 'local') {
      debug.warn(FN, 'wrong_provider', { provider: authUser.auth_provider });
      res.status(400).json({
        success : false,
        error   : `This account uses ${authUser.auth_provider} login. Please use that instead.`,
      });
      return;
    }

    // ── Step 4: Password verification ──
    debug.info(FN, 'verifying_password');
    const passwordMatch = await bcrypt.compare(password, authUser.password_hash);
    if (!passwordMatch) {
      debug.warn(FN, 'password_mismatch', { normalizedEmail });
      res.status(401).json({ success: false, error: 'Invalid email or password' });
      return;
    }

    // ── Step 5: Fetch profile ──
    const profile = await fetchProfileByAuthUserId(authUser.id);
    if (!profile) {
      debug.error(FN, 'profile_missing_for_auth_user', { auth_user_id: authUser.id });
      res.status(404).json({ success: false, error: 'Profile not found' });
      return;
    }

    // ── Step 6: Block check ──
    if (profile.is_blocked) {
      debug.warn(FN, 'account_blocked', { profile_id: profile.id });
      res.status(403).json({
        success : false,
        error   : 'Your account has been suspended. Contact support.',
      });
      return;
    }

     // ── Step 7: Build and return response ──
    const tokens = buildTokenPair(
      buildTokenPayload(authUser.id, profile.id, authUser.email),
    );

    // Fetch active subscription if it exists [1.2.4]
    const subscription = await fetchSubscriptionByProfileId(profile.id);
    const payments = await fetchPaymentsByProfileId(profile.id);

    debug.info(FN, 'success', { email: normalizedEmail, profile_id: profile.id });

    res.status(200).json({
      success : true,
      ...tokens,
      user    : buildUserResponse(authUser),
      profile : buildProfileResponse(profile),
      subscription: subscription, // Included [1.2.4]
      payments: payments,
    });

  } catch (err) {
    debug.error(FN, 'unhandled_exception', err);
    res.status(500).json({
      success : false,
      error   : 'Internal server error during login',
      ...(process.env.NODE_ENV !== 'production' && {
        detail: err instanceof Error ? err.message : String(err),
      }),
    });
  }
};

// =============================================================================
// 3. OAUTH CALLBACK
// =============================================================================
export const oauthCallback = async (req: Request, res: Response): Promise<void> => {
  const FN     = 'oauthCallback';
  const client = await pool.connect();

  try {
    // ── Step 1: Handle GitHub code exchange if needed ──
    let finalProviderId = req.body.provider_user_id as string | undefined;
    let finalEmail      = req.body.email            as string | undefined;

    if (req.body.provider === 'github' && req.body.code) {
      debug.info(FN, 'github_code_exchange_start', { code_length: req.body.code.length });

      const exchanged = await exchangeGitHubCode(req.body.code as string);

      if (!exchanged) {
        debug.warn(FN, 'github_code_exchange_failed');
        res.status(400).json({
          success : false,
          error   : 'Failed to exchange GitHub code. Please try again.',
        });
        return;
      }

      finalProviderId = exchanged.provider_user_id;
      finalEmail      = exchanged.email;

      debug.info(FN, 'github_code_exchange_success', {
        provider_user_id : finalProviderId,
        email            : finalEmail,
      });
    }

    // ── Step 2: Validate base OAuth fields ──
    const baseValidationError = validateOAuthCallbackBody({
      provider         : req.body.provider,
      provider_user_id : finalProviderId,
      email            : finalEmail,
    });

    if (baseValidationError) {
      debug.warn(FN, 'base_validation_failed', { baseValidationError });
      res.status(400).json({ success: false, error: baseValidationError });
      return;
    }

    const { provider, user_type, company_name } = req.body;
    const provider_user_id = finalProviderId!;
    const email            = finalEmail!;
    const normalizedEmail  = email.toLowerCase().trim();

    await client.query('BEGIN');
    debug.info(FN, 'tx_begin');

    // ── Step 2 (Lookup): Check for returning OAuth user ──
    const existingOAuth = await client.query(
      `SELECT id FROM auth_users
       WHERE auth_provider = $1 AND provider_user_id = $2`,
      [provider, provider_user_id],
    );

    const isNewUser = !existingOAuth.rowCount || existingOAuth.rowCount === 0;
    debug.info(FN, 'user_lookup', { isNewUser, provider, provider_user_id });

    let auth_user_id: string;

    if (!isNewUser) {
      auth_user_id = existingOAuth.rows[0].id;
      debug.info(FN, 'returning_user', { auth_user_id });

    } else {
      // ── New OAuth user registration ──
      const newUserValidationError = validateNewOAuthUserBody(req.body);
      if (newUserValidationError) {
        debug.warn(FN, 'new_user_validation_failed_onboarding_needed', { newUserValidationError });
        await client.query('ROLLBACK');
        
        // Return 200 with the already resolved credentials so the code is not wasted
        res.status(200).json({
          success : true,
          isNewUser: true,
          provider_user_id,
          email: normalizedEmail,
        });
        return;
      }

      // ── Step 3: Email conflict check ──
      const emailConflict = await checkEmailExists(client, normalizedEmail);
      if (emailConflict) {
        debug.warn(FN, 'email_conflict', {
          normalizedEmail,
          existingProvider: emailConflict.auth_provider,
        });
        await client.query('ROLLBACK');
        res.status(409).json({
          success : false,
          error   : `Email already registered via ${emailConflict.auth_provider}`,
        });
        return;
      }

      // ── Step 4: Insert auth user ──
      const authUser = await insertAuthUser(
        client,
        normalizedEmail,
        null,
        provider,
        provider_user_id,
        true,
      );

      auth_user_id = authUser.id;

      // ── Step 5: Derive unique username ──
      const username = await findAvailableUsername(client, normalizedEmail);

      // ── Step 6: Insert profile (Saves 'null' if individual) ──
      const profile = await insertProfile(
        client,
        auth_user_id,
        username,
        user_type,
        user_type === 'company' ? (company_name as string).trim() : null,
        FREE_SIGNUP_CREDITS,
      );

      // ── Step 7: Record free_grant transaction ──
      await insertFreeGrantTransaction(
        client,
        profile.id,
        FREE_SIGNUP_CREDITS,
        'Welcome bonus on OAuth signup',
      );

      debug.info(FN, 'new_user_created', { auth_user_id, profile_id: profile.id });
    }

    // ── Step 8: Commit ──
    await client.query('COMMIT');
    debug.info(FN, 'tx_committed');

    // ── Step 9: Fetch full rows for response ──
    const authUser = await fetchAuthUserById(auth_user_id);
    if (!authUser) {
      debug.error(FN, 'auth_user_missing_post_commit', { auth_user_id });
      res.status(500).json({ success: false, error: 'Unexpected error fetching user' });
      return;
    }

    const profile = await fetchProfileByAuthUserId(auth_user_id);
    if (!profile) {
      debug.error(FN, 'profile_missing_post_commit', { auth_user_id });
      res.status(500).json({ success: false, error: 'Unexpected error fetching profile' });
      return;
    }

    // ── Step 10: Block check ──
    if (profile.is_blocked) {
      debug.warn(FN, 'account_blocked', { profile_id: profile.id });
      res.status(403).json({ success: false, error: 'Account suspended. Contact support.' });
      return;
    }

    // ── Step 11: Build and return response ──
    const tokens = buildTokenPair(
      buildTokenPayload(auth_user_id, profile.id, normalizedEmail),
    );

    // Fetch active subscription if it exists [1.2.4]
    const subscription = await fetchSubscriptionByProfileId(profile.id);
    const payments = await fetchPaymentsByProfileId(profile.id); // Added [1.2.4]

    debug.info(FN, 'success', { auth_user_id, isNewUser });

    res.status(isNewUser ? 201 : 200).json({
      success   : true,
      isNewUser,
      ...tokens,
      user      : buildUserResponse(authUser),
      profile   : buildProfileResponse(profile),
      subscription: subscription, // Included [1.2.4]
      payments: payments,
    });


  } catch (err) {
    await client.query('ROLLBACK');
    debug.error(FN, 'unhandled_exception', err);
    res.status(500).json({
      success : false,
      error   : 'Internal server error during OAuth',
      ...(process.env.NODE_ENV !== 'production' && {
        detail: err instanceof Error ? err.message : String(err),
      }),
    });
  } finally {
    client.release();
    debug.info(FN, 'client_released');
  }
};

// =============================================================================
// 4. VERIFY EMAIL
// =============================================================================

const decodeAndValidatePurposeToken = (
  token: string,
  expectedPurpose: string,
): { auth_user_id: string } => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jwt     = require('jsonwebtoken');
  const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET as string) as any;

  if (decoded.purpose !== expectedPurpose) {
    throw new Error(`Invalid token purpose: expected ${expectedPurpose}, got ${decoded.purpose}`);
  }

  return { auth_user_id: decoded.auth_user_id };
};

export const verifyEmail = async (req: Request, res: Response): Promise<void> => {
  const FN = 'verifyEmail';

  try {
    const { token } = req.query;

    debug.info(FN, 'start', { hasToken: !!token });

    if (!token || typeof token !== 'string') {
      debug.warn(FN, 'missing_token');
      res.status(400).json({ success: false, error: 'Token is required' });
      return;
    }

    let decoded: { auth_user_id: string };
    try {
      decoded = decodeAndValidatePurposeToken(token, 'email_verify');
    } catch (err) {
      debug.warn(FN, 'invalid_token', { reason: err instanceof Error ? err.message : err });
      res.status(400).json({ success: false, error: 'Invalid or expired token' });
      return;
    }

    debug.info(FN, 'token_valid', { auth_user_id: decoded.auth_user_id });

    const result = await pool.query(
      `UPDATE auth_users
       SET email_verified = true, updated_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [decoded.auth_user_id],
    );

    if (!result.rowCount || result.rowCount === 0) {
      debug.warn(FN, 'user_not_found', { auth_user_id: decoded.auth_user_id });
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    debug.info(FN, 'success', { auth_user_id: decoded.auth_user_id });
    res.status(200).json({ success: true, message: 'Email verified successfully' });

  } catch (err) {
    debug.error(FN, 'unhandled_exception', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// =============================================================================
// 5. FORGOT PASSWORD
// =============================================================================
export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  const FN = 'forgotPassword';

  const safeResponse = () => {
    debug.info(FN, 'safe_response_sent');
    res.status(200).json({
      success : true,
      message : 'If that email exists, a reset link has been sent.',
    });
  };

  try {
    const { email } = req.body;
    debug.info(FN, 'start', { hasEmail: !!email });

    if (!email) {
      res.status(400).json({ success: false, error: 'email is required' });
      return;
    }

    const normalizedEmail = (email as string).toLowerCase().trim();

    const authUser = await fetchAuthUserByEmail(normalizedEmail);

    if (!authUser) {
      debug.warn(FN, 'email_not_found_safe_exit', { normalizedEmail });
      safeResponse(); // Safe exit to prevent email harvesting [2]
      return;
    }

    if (authUser.auth_provider !== 'local') {
      debug.warn(FN, 'oauth_account_safe_exit', { provider: authUser.auth_provider });
      safeResponse(); // Safe exit for OAuth users (cannot reset password) [2]
      return;
    }

    const jwt        = require('jsonwebtoken');
    const resetToken = jwt.sign(
      { auth_user_id: authUser.id, purpose: 'password_reset' },
      process.env.JWT_ACCESS_SECRET as string,
      { expiresIn: '15m' },
    );

    // 1. Compile the secure reset URL
    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    // 2. Dispatch email asynchronously via Nodemailer
    await emailService.sendPasswordResetEmail(normalizedEmail, resetLink);

    debug.info(FN, 'reset_token_generated_and_sent', {
      auth_user_id : authUser.id,
      ...(process.env.NODE_ENV !== 'production' && { resetToken }),
    });

    safeResponse();

  } catch (err) {
    debug.error(FN, 'unhandled_exception', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// =============================================================================
// 6. RESET PASSWORD
// =============================================================================
export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  const FN = 'resetPassword';

  try {
    const { token, newPassword } = req.body;
    debug.info(FN, 'start', { hasToken: !!token, hasPassword: !!newPassword });

    if (!token || !newPassword) {
      debug.warn(FN, 'missing_fields', { hasToken: !!token, hasPassword: !!newPassword });
      res.status(400).json({ success: false, error: 'token and newPassword are required' });
      return;
    }

    if ((newPassword as string).length < 8) {
      debug.warn(FN, 'password_too_short');
      res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
      return;
    }

    let decoded: { auth_user_id: string };
    try {
      decoded = decodeAndValidatePurposeToken(token, 'password_reset');
    } catch (err) {
      debug.warn(FN, 'invalid_token', { reason: err instanceof Error ? err.message : err });
      res.status(400).json({ success: false, error: 'Invalid or expired reset token' });
      return;
    }

    debug.info(FN, 'token_valid', { auth_user_id: decoded.auth_user_id });

    debug.info(FN, 'hashing_new_password');
    const password_hash = await bcrypt.hash(newPassword, SALT_ROUNDS);

    const result = await pool.query(
      `UPDATE auth_users
       SET password_hash = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id`,
      [password_hash, decoded.auth_user_id],
    );

    if (!result.rowCount || result.rowCount === 0) {
      debug.warn(FN, 'user_not_found', { auth_user_id: decoded.auth_user_id });
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    debug.info(FN, 'success', { auth_user_id: decoded.auth_user_id });
    res.status(200).json({ success: true, message: 'Password reset successfully' });

  } catch (err) {
    debug.error(FN, 'unhandled_exception', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// =============================================================================
// 7. REFRESH TOKEN
// =============================================================================
export const refreshToken = async (req: Request, res: Response): Promise<void> => {
  const FN = 'refreshToken';

  try {
    const { refreshToken: token } = req.body;
    debug.info(FN, 'start', { hasToken: !!token });

    if (!token) {
      debug.warn(FN, 'missing_token');
      res.status(400).json({ success: false, error: 'refreshToken is required' });
      return;
    }

    let decoded: JwtPayload;
    try {
      decoded = verifyRefreshToken(token);
    } catch (err) {
      debug.warn(FN, 'token_invalid', { reason: err instanceof Error ? err.message : err });
      res.status(401).json({ success: false, error: 'Invalid or expired refresh token' });
      return;
    }

    debug.info(FN, 'token_decoded', {
      auth_user_id : decoded.auth_user_id,
      profile_id   : decoded.profile_id,
    });

    const profile = await fetchProfileById(decoded.profile_id);
    if (!profile) {
      debug.warn(FN, 'profile_not_found', { profile_id: decoded.profile_id });
      res.status(401).json({ success: false, error: 'User not found' });
      return;
    }

    if (profile.is_blocked) {
      debug.warn(FN, 'account_blocked', { profile_id: decoded.profile_id });
      res.status(403).json({ success: false, error: 'Account suspended' });
      return;
    }

    const tokens = buildTokenPair(
      buildTokenPayload(decoded.auth_user_id, decoded.profile_id, decoded.email),
    );

    debug.info(FN, 'success', { profile_id: decoded.profile_id });

    res.status(200).json({
      success      : true,
      accessToken  : tokens.accessToken,
      refreshToken : tokens.refreshToken,
    });

  } catch (err) {
    debug.error(FN, 'unhandled_exception', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * Safely fetches the active subscription record for a profile if one exists [1.2.4].
 */
const fetchSubscriptionByProfileId = async (
  profile_id: string,
) => {
  debug.info('fetchSubscriptionByProfileId', 'querying', { profile_id });

  const result = await pool.query(
    `SELECT id, profile_id, payment_provider, provider_subscription_id, provider_customer_id,
            plan_code, subscription_status, billing_cycle, current_period_start, current_period_end,
            cancel_at_period_end, last_renewed_at, created_at, updated_at
     FROM subscriptions 
     WHERE profile_id = $1 AND subscription_status IN ('active', 'trialing', 'past_due')
     ORDER BY current_period_end DESC
     LIMIT 1;`,
    [profile_id],
  );

  if (!result.rowCount || result.rowCount === 0) {
    debug.info('fetchSubscriptionByProfileId', 'no_active_subscription_found', { profile_id });
    return null;
  }

  debug.info('fetchSubscriptionByProfileId', 'found', {
    subscription_id : result.rows[0].id,
    plan_code       : result.rows[0].plan_code,
  });

  return result.rows[0];
};


/**
 * Fetches the raw payments history ledger for a profile [1.2.4].
 */
const fetchPaymentsByProfileId = async (
  profile_id: string,
) => {
  debug.info('fetchPaymentsByProfileId', 'querying', { profile_id });

  const result = await pool.query(
    `SELECT id, amount, payment_status, created_at, currency_code, payment_type, credits_added
     FROM payments
     WHERE profile_id = $1
     ORDER BY created_at DESC;`,
    [profile_id],
  );

  return result.rows;
};

// =============================================================================
// 8. LOGOUT
// =============================================================================
export const logout = async (_req: Request, res: Response): Promise<void> => {
  const FN = 'logout';

  try {
    debug.info(FN, 'start');
    debug.info(FN, 'success');
    res.status(200).json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    debug.error(FN, 'unhandled_exception', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// =============================================================================
// 9. GET ME
// =============================================================================
export const getMe = async (req: Request, res: Response): Promise<void> => {
  const FN = 'getMe';

  try {
    const { auth_user_id, profile_id } = req.user!;
    debug.info(FN, 'start', { auth_user_id, profile_id });

    const authUser = await fetchAuthUserById(auth_user_id);
    if (!authUser) {
      debug.warn(FN, 'auth_user_not_found', { auth_user_id });
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const profile = await fetchProfileById(profile_id);
    if (!profile) {
      debug.error(FN, 'profile_missing_for_valid_token', { auth_user_id, profile_id });
      res.status(404).json({ success: false, error: 'Profile not found' });
      return;
    }

    if (profile.is_blocked) {
      debug.warn(FN, 'account_blocked', { profile_id });
      res.status(403).json({ success: false, error: 'Account suspended. Contact support.' });
      return;
    }

    // Fetch active subscription if it exists [1.2.4]
    const subscription = await fetchSubscriptionByProfileId(profile_id);
    const payments = await fetchPaymentsByProfileId(profile_id); // Added [1.2.4]

    debug.info(FN, 'success', { auth_user_id, profile_id });

    res.status(200).json({
      success : true,
      user    : buildUserResponse(authUser),
      profile : buildProfileResponse(profile),
      subscription: subscription, // Included [1.2.4]
      payments: payments,
    });

  } catch (err) {
    debug.error(FN, 'unhandled_exception', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};