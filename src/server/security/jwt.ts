/**
 * JWT authentication utilities.
 * Uses HS256 (HMAC-SHA256) for simplicity in development.
 * Switch to RS256 with key files for production.
 *
 * SECURITY NOTE: Refresh tokens are stored as bcrypt hashes.
 * To avoid O(N) bcrypt comparisons, the first TOKEN_PREFIX_LEN chars
 * of the raw token are stored in plaintext as a fast lookup key.
 * Only tokens matching the prefix are bcrypt-compared.
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { query } from '../persistence/db';
import { logger } from '../logger';

/** Length of the plaintext prefix stored alongside the bcrypt hash. */
const TOKEN_PREFIX_LEN = 8;

export interface JWTPayload {
  sub: string;        // userId
  email: string;
  displayName: string;
  iat: number;
  exp: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Signs a new access JWT for a user.
 */
export function signAccessToken(userId: string, email: string, displayName: string): string {
  return jwt.sign(
    { sub: userId, email, displayName },
    config.jwt.secret,
    { expiresIn: config.jwt.accessExpiry },
  );
}

/**
 * Verifies an access token and returns the payload.
 * Throws JsonWebTokenError or TokenExpiredError on failure.
 */
export function verifyAccessToken(token: string): JWTPayload {
  return jwt.verify(token, config.jwt.secret) as JWTPayload;
}

/**
 * Generates a refresh token, hashes it, and stores the hash in the DB.
 * Returns the RAW token (sent to client once, then forgotten).
 */
export async function createRefreshToken(userId: string): Promise<string> {
  const raw = uuidv4() + uuidv4(); // 72 random chars
  const prefix = raw.slice(0, TOKEN_PREFIX_LEN); // stored in plaintext for fast lookup
  const hash = await bcrypt.hash(raw, 10);
  const expiresAt = new Date(Date.now() + config.jwt.refreshExpiry * 1000);

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, token_prefix, expires_at) VALUES ($1, $2, $3, $4)`,
    [userId, hash, prefix, expiresAt],
  );

  return raw;
}

/**
 * Rotates a refresh token: validates the old one, revokes it, issues a new pair.
 */
export async function rotateRefreshToken(
  rawToken: string,
): Promise<{ userId: string; tokens: TokenPair } | null> {
  if (rawToken.length < TOKEN_PREFIX_LEN) return null; // malformed token

  // Use the prefix to narrow the candidate set to ~1 row before bcrypt
  const prefix = rawToken.slice(0, TOKEN_PREFIX_LEN);
  const rows = await query<{
    id: string; user_id: string; token_hash: string; email: string; display_name: string;
  }>(
    `SELECT rt.id, rt.user_id, rt.token_hash, u.email, u.display_name
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
      WHERE rt.token_prefix = $1
        AND rt.revoked = false
        AND rt.expires_at > now()`,
    [prefix],
  );

  for (const row of rows) {
    const matches = await bcrypt.compare(rawToken, row.token_hash);
    if (matches) {
      // Revoke old token
      await query(`UPDATE refresh_tokens SET revoked = true WHERE id = $1`, [row.id]);

      // Issue new pair
      const accessToken = signAccessToken(row.user_id, row.email, row.display_name);
      const newRefresh = await createRefreshToken(row.user_id);

      return {
        userId: row.user_id,
        tokens: {
          accessToken,
          refreshToken: newRefresh,
          expiresIn: config.jwt.accessExpiry,
        },
      };
    }
  }

  return null; // invalid or expired token
}

/**
 * Authenticates a user by email + password.
 */
export async function authenticateUser(
  email: string,
  password: string,
): Promise<TokenPair | null> {
  const rows = await query<{
    id: string; email: string; display_name: string; password_hash: string;
  }>(
    `SELECT id, email, display_name, password_hash FROM users WHERE email = $1`,
    [email],
  );

  if (rows.length === 0) return null;
  const user = rows[0];

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return null;

  const accessToken = signAccessToken(user.id, user.email, user.display_name);
  const refreshToken = await createRefreshToken(user.id);

  logger.info({ userId: user.id }, 'User authenticated');
  return { accessToken, refreshToken, expiresIn: config.jwt.accessExpiry };
}

/**
 * Registers a new user.
 */
export async function registerUser(params: {
  email: string;
  displayName: string;
  password: string;
  color?: string;
}): Promise<{ userId: string } | { error: string }> {
  const hash = await bcrypt.hash(params.password, 12);
  try {
    const rows = await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, color)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [params.email, params.displayName, hash, params.color ?? '#4F46E5'],
    );
    return { userId: rows[0].id };
  } catch (err: any) {
    if (err.code === '23505') return { error: 'Email already registered' };
    throw err;
  }
}
