import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { created, ok } from "../../utils/respond.js";
import { escapeRegex, objectId, pagination } from "../../utils/zodCommon.js";
import { Product } from "../../models/Product.js";
import { User } from "../../models/User.js";
import { Vendor, VENDOR_STATUSES, type VendorDoc } from "../../models/Vendor.js";
import { adminCreateVendorSchema, suspendSchema } from "./vendor.schemas.js";
import { sendAccountInviteEmail } from "../auth/emailTokens.service.js";
import { registerVendor } from "./vendor.service.js";
import { notifyVendorDecision } from "../accounts/accountEvents.js";
import { sendNinSlip } from "./identity.service.js";

// Mounted under /api/admin/vendors, so the ADMIN role check has already run.
export const adminVendorsRouter = Router();

/** Admin sees everything needed to review a store, including CAC and the full account number. */
const present = (v: VendorDoc, productCount?: number, ownerEmailVerified?: boolean) => ({
  id: String(v._id),
  slug: v.slug,
  businessName: v.businessName,
  ownerName: v.ownerName,
  email: v.email,
  phone: v.phone,
  cacNumber: v.cacNumber ?? null,
  // Identity: the full NIN is for admin review only. The slip itself is opened through its own route.
  nin: v.nin ?? null,
  ninSlip: v.ninSlip?.publicId ? { uploadedAt: v.ninSlip.uploadedAt ?? null, mime: v.ninSlip.mime ?? null } : null,
  description: v.description ?? null,
  status: v.status,
  statusReason: v.statusReason ?? null,
  approvedAt: v.approvedAt ?? null,
  createdAt: v.createdAt,
  bank: { bankName: v.bank!.bankName, accountNumber: v.bank!.accountNumber, accountName: v.bank!.accountName },
  pickup: { line: v.pickup!.line, lat: v.pickup!.lat, lng: v.pickup!.lng, cityId: String(v.pickup!.cityId) },
  ...(productCount === undefined ? {} : { productCount }),
  // Whether the owner has confirmed their email address. A store cannot be approved until they have.
  ...(ownerEmailVerified === undefined ? {} : { ownerEmailVerified }),
});

adminVendorsRouter.get(
  "/",
  validate({ query: pagination.extend({ status: z.enum(VENDOR_STATUSES).optional(), q: z.string().trim().max(100).optional() }) }),
  asyncHandler(async (req, res) => {
    const { page, limit, status, q } = req.validated.query;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (q) filter.businessName = new RegExp(escapeRegex(q), "i");
    const [items, total] = await Promise.all([
      Vendor.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Vendor.countDocuments(filter),
    ]);
    ok(res, items.map((v) => present(v)), { page, limit, total });
  }),
);

// The admin creates a store for someone. The owner gets an email to choose their own password (which also confirms the
// address), and the store then waits for approval like any other, because approval needs a confirmed email.
adminVendorsRouter.post(
  "/",
  validate({ body: adminCreateVendorSchema }),
  asyncHandler(async (req, res) => {
    // Never shown or sent: only here because an account needs one. The owner replaces it from the emailed link.
    const password = `${randomBytes(18).toString("base64url")}a1`;
    const { user, vendor } = await registerVendor({ ...req.validated.body, password });
    void sendAccountInviteEmail(user);
    created(res, present(vendor));
  }),
);

async function findVendor(id: string) {
  const vendor = await Vendor.findById(id);
  if (!vendor) throw AppError.notFound("Vendor not found");
  return vendor;
}

adminVendorsRouter.get(
  "/:id",
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const vendor = await findVendor(req.validated.params.id);
    const [productCount, owner] = await Promise.all([Product.countDocuments({ vendorId: vendor._id }), User.findById(vendor.userId)]);
    ok(res, present(vendor, productCount, owner?.emailVerified ?? true));
  }),
);

adminVendorsRouter.get(
  "/:id/nin-slip",
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    await sendNinSlip(res, await findVendor(req.validated.params.id));
  }),
);

// Approving also reinstates a suspended store.
adminVendorsRouter.post(
  "/:id/approve",
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const vendor = await findVendor(req.validated.params.id);
    const owner = await User.findById(vendor.userId);
    if (owner && !owner.emailVerified) {
      throw new AppError(409, "EMAIL_NOT_VERIFIED", "This store owner has not confirmed their email address yet. Ask them to use the link we emailed, then approve the store.");
    }
    vendor.status = "APPROVED";
    vendor.statusReason = undefined;
    vendor.approvedAt = vendor.approvedAt ?? new Date();
    await vendor.save();
    void notifyVendorDecision(vendor, "APPROVED");
    ok(res, present(vendor));
  }),
);

adminVendorsRouter.post(
  "/:id/suspend",
  validate({ params: z.object({ id: objectId }), body: suspendSchema }),
  asyncHandler(async (req, res) => {
    const vendor = await findVendor(req.validated.params.id);
    vendor.status = "SUSPENDED";
    vendor.statusReason = req.validated.body.reason;
    await vendor.save();
    void notifyVendorDecision(vendor, "SUSPENDED");
    ok(res, present(vendor));
  }),
);
