/**
 * Authentication Middleware
 * 
 * JWT-based authentication for protected routes.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jwt, { type SignOptions, type Secret } from 'jsonwebtoken';
import { env } from '../env';

const JWT_SECRET: Secret =
  env.JWT_SECRET ||
  (env.NODE_ENV === 'production' ? '' : 'development-secret-change-in-production');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JWTPayload {
  userId: string;
  username: string;
  iat?: number;
  exp?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: JWTPayload;
  }
}

// ─── Token Functions ──────────────────────────────────────────────────────────

/**
 * Generate a JWT token for a user
 */
export function generateToken(userId: string, username: string): string {
  const expiresIn = env.JWT_EXPIRES_IN || '7d';
  const options: SignOptions = { expiresIn: expiresIn as SignOptions['expiresIn'] };
  return jwt.sign({ userId, username }, JWT_SECRET, options);
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JWTPayload;
  } catch {
    return null;
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Extract and verify JWT from Authorization header
 * Sets req.user if valid, does not reject if invalid
 */
export async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const authHeader = request.headers.authorization;
    
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const payload = verifyToken(token);
      
      if (payload) {
        request.user = payload;
      }
    }
  });
}

/**
 * Route-level guard that requires authentication
 * Use as a preHandler on protected routes
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!request.user) {
    // Fallback verification in case the onRequest hook did not set user
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const payload = verifyToken(token);
      if (payload) {
        request.user = payload;
      }
    }

    if (!request.user) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Valid authentication token required',
      });
      return;
    }
  }
}

/**
 * Optional auth - doesn't reject, just sets user if available
 * Useful for routes that behave differently for authenticated users
 */
export async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  // The authPlugin already handles this, this is just a placeholder
  // for documentation purposes
}

/**
 * Check if the request is from an admin user
 * For now, admin status is based on username
 */
export function isAdmin(request: FastifyRequest): boolean {
  return request.user?.username === 'admin';
}
