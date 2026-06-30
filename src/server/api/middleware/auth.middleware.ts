/**
 * Auth middleware — verifies JWT and attaches user info to req.
 */

import type { Request, Response, NextFunction } from 'express';
import type * as core from 'express-serve-static-core';
import { verifyAccessToken } from '../../security/jwt';

export interface AuthenticatedRequest<
  P = core.ParamsDictionary,
  ResBody = any,
  ReqBody = any,
  ReqQuery = core.Query,
  Locals extends Record<string, any> = Record<string, any>
> extends Request<P, ResBody, ReqBody, ReqQuery, Locals> {
  userId: string;
  userEmail: string;
  displayName: string;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyAccessToken(token);
    (req as AuthenticatedRequest).userId = payload.sub;
    (req as AuthenticatedRequest).userEmail = payload.email;
    (req as AuthenticatedRequest).displayName = payload.displayName;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
