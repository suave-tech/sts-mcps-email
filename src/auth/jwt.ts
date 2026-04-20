import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

// Declaration merging — every Express Request now carries an optional
// userId. Handlers mounted behind requireAuth read it via getUserId(req),
// which narrows non-null or throws. Keeping the property optional avoids
// the "promise-you-set-it" lie that a bare `req.userId: string` would tell
// routes that forgot the middleware.
declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
  }
}

export function sign(userId: string): string {
  return jwt.sign({ sub: userId }, env.JWT_SECRET, { expiresIn: "7d" });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing_token" });
    return;
  }
  try {
    const decoded = jwt.verify(header.slice(7), env.JWT_SECRET) as { sub: string };
    req.userId = decoded.sub;
    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}

// Fails loud if called from a handler that forgot to mount requireAuth.
// In practice this throws → caught by the Express error handler → 500 with
// a request ID, which is exactly what you want to see in a log.
export function getUserId(req: Request): string {
  if (!req.userId) throw new Error("getUserId called without requireAuth middleware");
  return req.userId;
}

// Back-compat alias for any external caller still importing AuthedRequest.
// Prefer getUserId(req) in new code.
export type AuthedRequest = Request & { userId: string };
