import { Router } from "express";
import { z } from "zod";
import { calculateLineEarnings } from "../../domain/commission.js";
import { requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ok } from "../../utils/respond.js";
import { Product } from "../../models/Product.js";
import { getPricing } from "../../models/Settings.js";
import { ownVendor } from "../../models/Vendor.js";
import { getVendorForUser, updatePickup } from "./vendor.service.js";
import { updateBankSchema, updateNinSchema, updatePickupSchema, updateProfileSchema } from "./vendor.schemas.js";
import { saveNinSlip, sendNinSlip, setNin } from "./identity.service.js";
import { singleFile } from "../../middleware/upload.js";
import { AppError } from "../../utils/AppError.js";
import { vendorProductsRouter } from "../products/vendorProducts.routes.js";
import { vendorUploadRouter } from "../products/uploads.routes.js";
import { vendorOrdersRouter, VENDOR_GROUPS } from "./vendorOrders.routes.js";
import { vendorEarningsRouter } from "../earnings/vendorEarnings.routes.js";
import { SubOrder } from "../../models/SubOrder.js";

export const vendorRouter = Router();
vendorRouter.use(requireRole("VENDOR"));

vendorRouter.get("/ping", (req, res) => ok(res, { area: "vendor", userId: String(req.user!._id) }));

// The service fee VendraMart keeps from each sale, so a vendor knows what they will receive. With ?priceKobo= it also works out
// the fee and the amount received for one item at that price, with the same function orders use. Only vendors can ask.
vendorRouter.get(
  "/fees",
  validate({ query: z.object({ priceKobo: z.coerce.number().int().min(0).max(10_000_000_000).optional() }) }),
  asyncHandler(async (req, res) => {
    const { commissionBps } = await getPricing();
    const { priceKobo } = req.validated.query as { priceKobo?: number };
    if (priceKobo === undefined || priceKobo < 1) return ok(res, { serviceFeeBps: commissionBps });
    const { commissionKobo, vendorEarningKobo } = calculateLineEarnings(priceKobo, 1, commissionBps);
    ok(res, { serviceFeeBps: commissionBps, priceKobo, serviceFeeKobo: commissionKobo, youReceiveKobo: vendorEarningKobo });
  }),
);

vendorRouter.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user!._id);
    const [toPrepare, products, activeProducts, outOfStock] = await Promise.all([
      SubOrder.countDocuments({ vendorId: vendor._id, status: { $in: [...VENDOR_GROUPS.todo] } }),
      Product.countDocuments({ vendorId: vendor._id }),
      Product.countDocuments({ vendorId: vendor._id, isActive: true }),
      Product.countDocuments({ vendorId: vendor._id, stock: 0 }),
    ]);
    ok(res, { vendor: ownVendor(vendor), counts: { products, activeProducts, outOfStock, toPrepare } });
  }),
);

vendorRouter.get(
  "/profile",
  asyncHandler(async (req, res) => ok(res, ownVendor(await getVendorForUser(req.user!._id)))),
);

vendorRouter.patch(
  "/profile",
  validate({ body: updateProfileSchema }),
  asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user!._id);
    // The logo is changed only by uploading one (POST /vendor/uploads/logo), so it is always a file in our Cloudinary folder.
    Object.assign(vendor, req.validated.body);
    await vendor.save();
    ok(res, ownVendor(vendor));
  }),
);

vendorRouter.patch(
  "/bank",
  validate({ body: updateBankSchema }),
  asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user!._id);
    vendor.bank = req.validated.body;
    await vendor.save();
    ok(res, ownVendor(vendor));
  }),
);

vendorRouter.patch(
  "/pickup",
  validate({ body: updatePickupSchema }),
  asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user!._id);
    ok(res, ownVendor(await updatePickup(vendor, req.validated.body)));
  }),
);

vendorRouter.patch(
  "/identity",
  validate({ body: updateNinSchema }),
  asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user!._id);
    ok(res, ownVendor(await setNin(vendor, req.validated.body.nin)));
  }),
);

vendorRouter.post(
  "/identity/slip",
  singleFile,
  asyncHandler(async (req, res) => {
    if (!req.file) throw AppError.validation("Choose the NIN slip to upload", [{ path: "file", message: "Choose the NIN slip to upload" }]);
    const vendor = await getVendorForUser(req.user!._id);
    ok(res, ownVendor(await saveNinSlip(vendor, req.file.buffer)));
  }),
);

vendorRouter.get(
  "/identity/slip",
  asyncHandler(async (req, res) => {
    await sendNinSlip(res, await getVendorForUser(req.user!._id));
  }),
);

vendorRouter.use("/orders", vendorOrdersRouter);
vendorRouter.use(vendorEarningsRouter);
vendorRouter.use("/products", vendorProductsRouter);
vendorRouter.use("/uploads", vendorUploadRouter);
