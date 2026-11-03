import { env, isProd } from "./config/env.js";
import { checkProductionConfig } from "./config/productionChecks.js";
import { connectDb, disconnectDb } from "./config/db.js";
import { createApp } from "./app.js";
import { User } from "./models/User.js";
import { Address } from "./models/Address.js";
import { Order } from "./models/Order.js";
import { SubOrder } from "./models/SubOrder.js";
import { WebhookEvent } from "./models/WebhookEvent.js";
import { expireStaleOrders } from "./modules/orders/orders.service.js";
import { seedReferenceData } from "./seed/reference.js";
import { completeDeliveredOrders } from "./modules/orders/subOrderTransitions.js";

/** A live server must not start with an unsafe setting, and says plainly what is not set up yet. */
function checkLiveSettings() {
  const { errors, warnings } = checkProductionConfig(env);
  if (errors.length) {
    console.error(`\nThe server will not start. Fix these settings first:\n${errors.map((e) => `  - ${e}`).join("\n")}\n`);
    process.exit(1);
  }
  if (warnings.length) console.warn(`\nNot ready for real customers yet:\n${warnings.map((w) => `  - ${w}`).join("\n")}\n`);
  else console.log("Production settings check: all set.");
}

async function main() {
  if (isProd) checkLiveSettings();
  const conn = await connectDb(env.MONGODB_URI);
  // Make sure unique indexes (e.g. User.email, Order payment reference, webhook event keys) exist before taking traffic.
  await Promise.all([User.init(), Address.init(), Order.init(), SubOrder.init(), WebhookEvent.init()]);
  console.log(`MongoDB connected: ${conn.name}`);

  // A brand-new database has no cities or categories, and the storefront cannot work without them.
  // This only ever INSERTS missing ones (never changes an existing city's live/coming-soon setting).
  await seedReferenceData();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`VendraMart API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  // When the host restarts or replaces the server (a new deploy), finish the requests in flight and close the database
  // cleanly instead of cutting them off, for example in the middle of recording a payment.
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: finishing current requests, then stopping`);
    const force = setTimeout(() => {
      console.error("Could not stop cleanly within 15 seconds, stopping now");
      process.exit(1);
    }, 15_000);
    force.unref();
    server.close(() => {
      disconnectDb()
        .catch(() => {})
        .finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Unpaid orders hold stock, so release it when the payment window passes. Reads also expire on demand;
  // this just makes sure it happens even if nobody looks.
  const sweep = () =>
    Promise.all([
      expireStaleOrders().then((n) => n > 0 && console.log(`Expired ${n} unpaid order(s) and returned their stock`)),
      // Delivered orders become COMPLETED once their earnings hold has passed.
      completeDeliveredOrders().then((n) => n > 0 && console.log(`Completed ${n} delivered order(s) after the earnings hold`)),
    ]).catch((err) => console.error("Order sweep failed:", err));
  setInterval(sweep, 60_000).unref();
}

// A forgotten promise that fails is logged with its reason instead of ending the process unseen.
process.on("unhandledRejection", (reason) => console.error("Unhandled promise rejection:", reason));

main().catch((err) => {
  console.error("Failed to start server:", err.message ?? err);
  process.exit(1);
});
