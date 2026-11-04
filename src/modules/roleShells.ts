import { Router } from "express";
import { requirePermission, requireRole, requireSuperAdmin } from "../middleware/auth.js";
import { ok } from "../utils/respond.js";
import { adminBannersRouter } from "./banners/banners.routes.js";
import { adminCategoriesRouter } from "./admin/adminCategories.routes.js";
import { adminDeleteRouter } from "./admin/adminDelete.routes.js";
import { adminVendorsRouter } from "./vendors/adminVendors.routes.js";
import { adminVendorMessagesRouter } from "./vendors/adminVendorMessages.routes.js";
import { addressesRouter } from "./addresses/addresses.routes.js";
import { adminDeliveriesRouter } from "./admin/adminDeliveries.routes.js";
import { adminStaffRouter } from "./admin/adminStaff.routes.js";
import { handlerDeliveriesRouter } from "./handlers/handlerDeliveries.routes.js";
import { adminPayoutsRouter } from "./payouts/adminPayouts.routes.js";
import { adminCustomersRouter } from "./admin/adminCustomers.routes.js";
import { adminOrdersRouter } from "./admin/adminOrders.routes.js";
import { adminOverviewRouter } from "./admin/adminOverview.routes.js";
import { adminSearchRouter } from "./admin/adminSearch.routes.js";
import { adminSettingsRouter } from "./admin/adminSettings.routes.js";

// Role-guarded routers. The guard is applied once at the router level so a route added to one of
// these can never be reached without the right role. The vendor router lives in vendors/.
export const adminRouter = Router();
adminRouter.use(requireRole("ADMIN"));
adminRouter.get("/ping", (req, res) => ok(res, { area: "admin", userId: String(req.user!._id) }));

// A super admin passes every guard below. A staff member (operations manager, finance manager...) passes only the areas the
// super admin gave them. Each guard lists the address prefixes it covers, so routers mounted at the root stay separate.
adminRouter.delete(["/customers/:id", "/vendors/:id", "/staff/:id"], requireSuperAdmin);
adminRouter.use("/vendors", requirePermission("vendors"));
adminRouter.use(["/banners", "/categories"], requirePermission("catalog"));
adminRouter.use("/payouts", requirePermission("payouts"));
adminRouter.use("/overview", requirePermission("overview"));
adminRouter.use("/orders", requirePermission("orders"));
adminRouter.use("/customers", requirePermission("customers"));
adminRouter.use(["/settings", "/cities"], requirePermission("settings"));
adminRouter.use(["/deliveries", "/sub-orders"], requirePermission("deliveries"));
// /staff checks its own rules (managers may handle delivery handlers only) and /search trims its results to what they may open.

adminRouter.use("/vendors", adminVendorsRouter);
adminRouter.use("/vendors", adminVendorMessagesRouter);
adminRouter.use("/staff", adminStaffRouter);
adminRouter.use("/banners", adminBannersRouter);
adminRouter.use("/categories", adminCategoriesRouter);
adminRouter.use(adminDeleteRouter);
adminRouter.use("/payouts", adminPayoutsRouter);
adminRouter.use(adminOverviewRouter);
adminRouter.use(adminOrdersRouter);
adminRouter.use(adminCustomersRouter);
adminRouter.use(adminSettingsRouter);
adminRouter.use(adminSearchRouter);
adminRouter.use(adminDeliveriesRouter);

export const handlerRouter = Router();
handlerRouter.use(requireRole("HANDLER"));
handlerRouter.get("/ping", (req, res) => ok(res, { area: "handler", userId: String(req.user!._id) }));
handlerRouter.use("/deliveries", handlerDeliveriesRouter);

export const customerRouter = Router();
customerRouter.use(requireRole("CUSTOMER"));
customerRouter.use("/addresses", addressesRouter);
customerRouter.get("/ping", (req, res) => ok(res, { area: "customer", userId: String(req.user!._id) }));
