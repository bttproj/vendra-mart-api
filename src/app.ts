import express from "express";
import helmet from "helmet";
import cors from "cors";
import { env, clientOrigins } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { adminRouter, customerRouter, handlerRouter } from "./modules/roleShells.js";
import { vendorRouter } from "./modules/vendors/vendor.routes.js";
import { bannersRouter } from "./modules/banners/banners.routes.js";
import { referenceRouter } from "./modules/cities/cities.routes.js";
import { catalogRouter } from "./modules/products/catalog.routes.js";
import { cartRouter, checkoutRouter } from "./modules/checkout/checkout.routes.js";
import { LOCAL_UPLOAD_ROOT, LOCAL_URL_PREFIX } from "./services/storage/LocalDiskStorage.js";
import { isProd } from "./config/env.js";
import { devPaymentsRouter } from "./modules/orders/devPayments.routes.js";
import { ordersRouter } from "./modules/orders/orders.routes.js";
import { notificationsRouter } from "./modules/notifications/notifications.routes.js";
import { receiptRouter } from "./modules/payouts/receipt.routes.js";
import { mountPaystackWebhook } from "./modules/orders/webhook.routes.js";
import mongoose from "mongoose";
import { requestLog } from "./middleware/requestLog.js";
import { asyncHandler } from "./utils/asyncHandler.js";
import { ok } from "./utils/respond.js";

export function createApp() {
  const app = express();

  // This API sits behind the host's proxy (Render, a load balancer), so the real IP arrives in X-Forwarded-For.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // The website is on another address, and shows images this API serves in development, so they must be loadable cross-origin.
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  if (isProd) app.use(requestLog);

  // The website is a static site on its own address, so the browser calls this API cross-origin. Signing in is a JWT sent
  // in the Authorization header, so no cookie or credentials mode is involved.
  app.use(cors({ origin: clientOrigins, maxAge: 86400 }));

  // The Paystack webhook (Phase 4) needs the raw body for signature checks, so it is mounted
  // BEFORE express.json() with express.raw(). Everything else gets parsed JSON.
  mountPaystackWebhook(app);
  app.use(express.json({ limit: "100kb" }));

  // Local-disk image fallback (dev and tests only; production uses Cloudinary).
  if (!isProd) {
    app.use(LOCAL_URL_PREFIX, express.static(LOCAL_UPLOAD_ROOT, { index: false, dotfiles: "deny" }));
  }

  const api = express.Router();
  // /health says the process is up. /health/ready also checks the database, so a host can stop sending traffic to a
  // server that has lost it (and start it again) instead of serving errors.
  api.get("/health", (_req, res) => ok(res, { status: "ok" }));
  api.get(
    "/health/ready",
    asyncHandler(async (_req, res) => {
      try {
        if (mongoose.connection.readyState !== 1) throw new Error("not connected");
        await mongoose.connection.db!.admin().ping();
        ok(res, { status: "ready" });
      } catch {
        res.status(503).json({ success: false, error: { code: "SERVICE_UNAVAILABLE", message: "The database is not reachable" } });
      }
    }),
  );
  api.use(referenceRouter);
  api.use(bannersRouter);
  api.use(catalogRouter);
  api.use("/cart", cartRouter);
  api.use("/checkout", checkoutRouter);
  api.use("/orders", ordersRouter);
  api.use("/notifications", notificationsRouter);
  api.use("/payouts", receiptRouter);
  if (!isProd) api.use("/dev/paystack", devPaymentsRouter);
  api.use("/auth", authRouter);
  api.use("/admin", adminRouter);
  api.use("/vendor", vendorRouter);
  api.use("/handler", handlerRouter);
  api.use("/me", customerRouter);
  app.use("/api", api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
