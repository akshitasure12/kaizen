/**
 * Authentication Routes
 * 
 * POST /auth/register - Create new user account
 * POST /auth/login - Authenticate and get JWT
 * GET /auth/me - Get current user info (requires auth)
 */

import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db/client';
import { generateToken, requireAuth } from '../middleware/auth';
import { getUserGitHubAuthFlags, setUserGithubApiKey, validateGitHubToken } from '../services/github-integration';

const SALT_ROUNDS = 10;

interface User {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
}

interface UserPublic {
  id: string;
  username: string;
  created_at: string;
}

export async function authRoutes(app: FastifyInstance) {
  /**
   * Register a new user
   */
  app.post('/register', async (req, reply) => {
    const { username, password } = req.body as any;

    // Validation
    if (!username || !password) {
      return reply.status(400).send({
        error: 'Validation failed',
        message: 'Username and password are required',
      });
    }

    if (username.length < 3 || username.length > 50) {
      return reply.status(400).send({
        error: 'Validation failed',
        message: 'Username must be 3-50 characters',
      });
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return reply.status(400).send({
        error: 'Validation failed',
        message: 'Username can only contain letters, numbers, underscores, and hyphens',
      });
    }

    if (password.length < 8) {
      return reply.status(400).send({
        error: 'Validation failed',
        message: 'Password must be at least 8 characters',
      });
    }

    // Check if username exists
    const existing = await queryOne<User>(
      'SELECT id FROM users WHERE username = $1',
      [username.toLowerCase()]
    );

    if (existing) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Username already taken',
      });
    }

    // Hash password and create user
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

    const [user] = await query<User>(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username, created_at`,
      [username.toLowerCase(), password_hash]
    );

    // Generate token
    const token = generateToken(user.id, user.username);

    return reply.status(201).send({
      message: 'User registered successfully',
      user: {
        id: user.id,
        username: user.username,
        created_at: user.created_at,
      },
      token,
    });
  });

  /**
   * Login with username and password
   */
  app.post('/login', async (req, reply) => {
    const { username, password } = req.body as any;

    if (!username || !password) {
      return reply.status(400).send({
        error: 'Validation failed',
        message: 'Username and password are required',
      });
    }

    // Find user
    const user = await queryOne<User>(
      'SELECT * FROM users WHERE username = $1',
      [username.toLowerCase()]
    );

    if (!user) {
      return reply.status(401).send({
        error: 'Authentication failed',
        message: 'Invalid username or password',
      });
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return reply.status(401).send({
        error: 'Authentication failed',
        message: 'Invalid username or password',
      });
    }

    // Generate token
    const token = generateToken(user.id, user.username);

    return reply.send({
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        created_at: user.created_at,
      },
      token,
    });
  });

  /**
   * Get current authenticated user
   */
  app.get('/me', { preHandler: requireAuth }, async (req, reply) => {
    const user = await queryOne<UserPublic>(
      'SELECT id, username, created_at FROM users WHERE id = $1',
      [req.user!.userId]
    );

    if (!user) {
      return reply.status(404).send({
        error: 'Not found',
        message: 'User no longer exists',
      });
    }

    // Get user's agents
    const agents = await query(
      `SELECT id, ens_name, role, reputation_score, deposit_verified
       FROM agents WHERE user_id = $1
       ORDER BY created_at DESC`,
      [user.id]
    );

    const github = await getUserGitHubAuthFlags(user.id);

    return reply.send({
      user,
      agents,
      github,
    });
  });

  /**
   * Store or clear per-user GitHub Personal Access Token / fine-grained token (used for API + git HTTPS).
   * Stored on users.github_api_key; never returned from GET /auth/me.
   */
  app.patch('/github-api-key', { preHandler: requireAuth }, async (req, reply) => {
    const { github_api_key } = req.body as { github_api_key?: string | null };

    if (github_api_key === undefined) {
      return reply.status(400).send({ error: 'github_api_key is required (use null to clear)' });
    }

    if (github_api_key !== null && github_api_key !== '') {
      if (typeof github_api_key !== 'string') {
        return reply.status(400).send({ error: 'github_api_key must be a string or null' });
      }
      if (github_api_key.length > 4000) {
        return reply.status(400).send({ error: 'github_api_key is too long' });
      }
      if (github_api_key.trim().length === 0) {
        return reply.status(400).send({ error: 'github_api_key cannot be only whitespace' });
      }

      // Validate GitHub token before storing
      const tokenValue = github_api_key.trim();
      const validation = await validateGitHubToken(tokenValue);
      if (!validation.ok) {
        if (validation.status === 401) {
          return reply.status(401).send({
            error: 'Token invalid',
            code: 'GITHUB_TOKEN_INVALID',
            message: validation.githubMessage ?? 'The GitHub token is invalid or expired. Please check your token and try again.',
          });
        }
        if (validation.status === 403) {
          // Check if it's specifically an insufficient permissions issue
          if (validation.reason === 'insufficient_permissions') {
            return reply.status(403).send({
              error: 'Insufficient permissions',
              code: 'GITHUB_TOKEN_INSUFFICIENT_PERMISSIONS',
              message: validation.githubMessage ?? 'The token lacks required permissions. Please create a fine-grained token with: Repository (read & write), Issues (read & write), and Pull Requests (read & write) permissions.',
            });
          }
          return reply.status(403).send({
            error: 'Token forbidden',
            code: 'GITHUB_TOKEN_FORBIDDEN',
            message: validation.githubMessage ?? 'The token has insufficient permissions or is restricted.',
          });
        }
        return reply.status(502).send({
          error: 'GitHub API error',
          code: 'GITHUB_VALIDATION_ERROR',
          message: validation.githubMessage ?? 'Unable to validate GitHub token. Please try again later.',
          status: validation.status,
        });
      }
    }

    const value = github_api_key === null || github_api_key === '' ? null : github_api_key.trim();
    await setUserGithubApiKey(req.user!.userId, value);

    const github = await getUserGitHubAuthFlags(req.user!.userId);
    return reply.send({
      message: value ? 'GitHub API key saved' : 'GitHub API key cleared',
      github: { api_key_configured: github.api_key_configured },
    });
  });

  /**
   * Change password (requires auth)
   */
  app.post('/change-password', { preHandler: requireAuth }, async (req, reply) => {
    const { currentPassword, newPassword } = req.body as any;

    if (!currentPassword || !newPassword) {
      return reply.status(400).send({
        error: 'Validation failed',
        message: 'Current password and new password are required',
      });
    }

    if (newPassword.length < 8) {
      return reply.status(400).send({
        error: 'Validation failed',
        message: 'New password must be at least 8 characters',
      });
    }

    // Get current user with password hash
    const user = await queryOne<User>(
      'SELECT * FROM users WHERE id = $1',
      [req.user!.userId]
    );

    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    // Verify current password
    const valid = await bcrypt.compare(currentPassword, user.password_hash);

    if (!valid) {
      return reply.status(401).send({
        error: 'Authentication failed',
        message: 'Current password is incorrect',
      });
    }

    // Update password
    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

    await query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [newHash, user.id]
    );

    return reply.send({
      message: 'Password changed successfully',
    });
  });
}
