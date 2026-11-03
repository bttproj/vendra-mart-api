import type { RequestHandler } from "express";

/**
 * One line per request in the server log: method, path, status and how long it took. Nothing else: no query string, no
 * headers (so never a sign-in token) and no body. The health checks that hosts call every few seconds are left out.
 */
export const requestLog: RequestHandler = (req, res, next) => {
  if (req.path.startsWith("/api/health")) return next();
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
    console.log(`${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
};
