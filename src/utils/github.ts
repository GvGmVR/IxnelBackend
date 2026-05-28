// src/utils/github.ts

interface GitHubUserResponse {
  id    : number;      // GitHub's user ID
  email : string;
  login : string;      // GitHub username
}

interface GitHubEmailResponse {
  email    : string;
  primary  : boolean;
  verified : boolean;
}

/**
 * Exchange GitHub OAuth code for user data
 * Returns provider_user_id (GitHub's user ID) and email
 */
export async function exchangeGitHubCode(code: string): Promise<{
  provider_user_id : string;
  email            : string;
} | null> {
  const clientId     = process.env.GITHUB_CLIENT_ID;  
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('[github][exchangeCode] missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET');
    return null;
  }

  try {
    // ── Step 1: Exchange code for access token ──────────────────────────
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method  : 'POST',
      headers : {
        'Accept'       : 'application/json',
        'Content-Type' : 'application/json',
      },
      body: JSON.stringify({
        client_id     : clientId,
        client_secret : clientSecret,
        code,
      }),
    });

    if (!tokenResponse.ok) {
      console.error('[github][exchangeCode] token exchange failed', {
        status: tokenResponse.status,
      });
      return null;
    }

    const tokenData = await tokenResponse.json() as { access_token?: string; error?: string };

    if (!tokenData.access_token) {
      console.error('[github][exchangeCode] no access_token in response', {
        error: tokenData.error,
      });
      return null;
    }

    const accessToken = tokenData.access_token;

    // ── Step 2: Fetch user data ─────────────────────────────────────────
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization' : `Bearer ${accessToken}`,
        'Accept'        : 'application/vnd.github.v3+json',
      },
    });

    if (!userResponse.ok) {
      console.error('[github][exchangeCode] user fetch failed', {
        status: userResponse.status,
      });
      return null;
    }

    const userData = await userResponse.json() as GitHubUserResponse;

    // ── Step 3: Get primary verified email ──────────────────────────────
    // GitHub user object email can be null if user has it private
    // Must fetch from /user/emails endpoint
    let email = userData.email;

    if (!email) {
      const emailsResponse = await fetch('https://api.github.com/user/emails', {
        headers: {
          'Authorization' : `Bearer ${accessToken}`,
          'Accept'        : 'application/vnd.github.v3+json',
        },
      });

      if (emailsResponse.ok) {
        const emails = await emailsResponse.json() as GitHubEmailResponse[];
        const primaryEmail = emails.find((e) => e.primary && e.verified);
        if (primaryEmail) {
          email = primaryEmail.email;
        }
      }
    }

    if (!email) {
      console.error('[github][exchangeCode] no verified email found');
      return null;
    }

    console.log('[github][exchangeCode] success', {
      github_id : userData.id,
      email,
    });

    return {
      provider_user_id : String(userData.id),
      email,
    };

  } catch (err) {
    console.error('[github][exchangeCode] exception', err);
    return null;
  }
}