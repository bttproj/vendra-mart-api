import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";
import { User, type Role, type UserDoc } from "../models/User.js";
import { hasAnyPermission, isSuperAdmin, type Permission } from "../domain/permissions.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: UserDoc;
  }
}

export interface TokenPayload {
  sub: string;
  role: Role;
}

export function signToken(userId: string, role: Role) {
  return jwt.sign({ sub: userId, role } satisfies TokenPayload, env.JWT_SECRET, {
    expiresIn: `${env.JWT_EXPIRES_IN_DAYS}d`,
  });
}

/** The signed-in user's token arrives as `Authorization: Bearer <token>`. There is no cookie. */
function readToken(req: Parameters<RequestHandler>[0]): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(req.header("authorization") ?? "");
  return match?.[1];
}

async function loadUser(req: Parameters<RequestHandler>[0]): Promise<UserDoc | null> {
  const token = readToken(req);
  if (!token) return null;
  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
  // Load from the DB on every request so a suspension or role change applies immediately.
  const user = await User.findById(payload.sub);
  if (!user || !user.isActive) return null;
  return user;
}

/** Attaches req.user if a valid session exists. Never rejects. */
export const optionalAuth: RequestHandler = async (req, _res, next) => {
  try {
    const user = await loadUser(req);
    if (user) req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

/** Requires a valid session. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const user = await loadUser(req);
    if (!user) return next(AppError.unauthenticated());
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

/** After requireRole("ADMIN"): the account must be a super admin or a staff member who was given this area. */
export const requirePermission = (...permissions: Permission[]): RequestHandler => {
  return (req, _res, next) => {
    if (!req.user || !hasAnyPermission(req.user, permissions)) return next(AppError.forbidden("Your account does not have access to this part of the dashboard."));
    next();
  };
};

/** After requireRole("ADMIN"): super admins only (creating other staff, deleting accounts). */
export const requireSuperAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user || !isSuperAdmin(req.user)) return next(AppError.forbidden("Only a super admin can do this."));
  next();
};

/** Requires a valid session AND one of the given roles. Use on every non-public router. */
export const requireRole = (...roles: Role[]): RequestHandler => {
  return async (req, res, next) => {
    await requireAuth(req, res, (err?: unknown) => {
      if (err) return next(err);
      if (!req.user || !roles.includes(req.user.role)) return next(AppError.forbidden());
      next();
    });
  };
};
