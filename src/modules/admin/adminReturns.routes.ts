import { Router } from "express";
import { z } from "zod";
import { maxRefundKobo } from "../../domain/returns.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ok } from "../../utils/respond.js";
import { escapeRegex, kobo, objectId, pagination } from "../../utils/zodCommon.js";
import { ReturnRequest, type ReturnRequestDoc } from "../../models/ReturnRequest.js";
import { SubOrder } from "../../models/SubOrder.js";
import { User } from "../../models/User.js";
import { Vendor } from "../../models/Vendor.js";
import { presentReturn } from "../returns/returns.present.js";
import { completeReturn, confirmReturn, rejectReturn } from "../returns/returns.service.js";

// Mounted under /api/admin/returns, behind requireRole("ADMIN") and the orders area.
// Customers lodge returns and problem reports; here the team confirms or rejects them, and records the refund inside the
// 7 working day refund deadline that starts when a case is confirmed. Refunds are made by hand in Paystack and recorded here.
export const adminReturnsRouter = Router();

const GROUPS = {
  needs_decision: { status: "REQUESTED" },
  window: { status: "CONFIRMED" },
  closed: { status: { $in: ["COMPLETED", "REJECTED", "CANCELLED"] } },
  all: {},
} as const;
type Group = keyof typeof GROUPS;

async function presentForAdmin(cases: ReturnRequestDoc[]) {
  const now = new Date();
  const [customers, vendors, subs] = await Promise.all([
    User.find({ _id: { $in: cases.map((c) => c.customerId) } }).select("name email phone"),
    Vendor.find({ _id: { $in: cases.map((c) => c.vendorId) } }).select("businessName"),
    SubOrder.find({ _id: { $in: cases.map((c) => c.subOrderId) } }).select("delivery.feeKobo"),
  ]);
  const customer = new Map(customers.map((u) => [String(u._id), u]));
  const vendor = new Map(vendors.map((v) => [String(v._id), v.businessName]));
  const fee = new Map(subs.map((s) => [String(s._id), s.delivery!.feeKobo]));
  return cases.map((c) => {
    const base = presentReturn(c, now);
    return {
      ...base,
      customer: { name: customer.get(String(c.customerId))?.name ?? "Customer", email: customer.get(String(c.customerId))?.email ?? null, phone: customer.get(String(c.customerId))?.phone ?? null },
      vendor: { id: String(c.vendorId), businessName: vendor.get(String(c.vendorId)) ?? "Store" },
      refundNote: c.refundNote ?? null,
      restocked: c.restocked ?? false,
      // The most that can be refunded: the goods, plus the delivery fee when the whole delivery is being refunded.
      maxRefundKobo: maxRefundKobo(base.goodsKobo, fee.get(String(c.subOrderId)) ?? 0, c.wholeDelivery ?? false),
      wholeDelivery: c.wholeDelivery ?? false,
    };
  });
}

adminReturnsRouter.get(
  "/",
  validate({ query: pagination.extend({ group: z.enum(["needs_decision", "window", "closed", "all"]).default("needs_decision"), q: z.string().trim().max(60).optional() }) }),
  asyncHandler(async (req, res) => {
    const { group, page, limit, q } = req.validated.query as { group: Group; page: number; limit: number; q?: string };
    const filter: Record<string, unknown> = { ...GROUPS[group] };
    if (q) {
      const re = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ number: re }, { orderNumber: re }, { subOrderRef: re }];
    }
    // Oldest first where someone has to act (so nothing waits at the bottom), nearest window end first, newest first once closed.
    const sort: Record<string, 1 | -1> = group === "needs_decision" ? { createdAt: 1 } : group === "window" ? { windowEndsAt: 1 } : { createdAt: -1 };
    const [items, total] = await Promise.all([
      ReturnRequest.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit),
      ReturnRequest.countDocuments(filter),
    ]);
    ok(res, await presentForAdmin(items), { page, limit, total });
  }),
);

// The numbers for the tabs and the badge beside "Returns" in the menu. `overdue` is the confirmed cases past their refund deadline.
adminReturnsRouter.get(
  "/counts",
  asyncHandler(async (_req, res) => {
    const [needsDecision, window, overdue, closed, all] = await Promise.all([
      ReturnRequest.countDocuments(GROUPS.needs_decision),
      ReturnRequest.countDocuments(GROUPS.window),
      ReturnRequest.countDocuments({ status: "CONFIRMED", windowEndsAt: { $lt: new Date() } }),
      ReturnRequest.countDocuments(GROUPS.closed),
      ReturnRequest.countDocuments({}),
    ]);
    ok(res, { needs_decision: needsDecision, window, overdue, closed, all });
  }),
);

const idParams = z.object({ id: objectId });

adminReturnsRouter.post(
  "/:id/confirm",
  validate({ params: idParams, body: z.object({ note: z.string().trim().max(500).optional() }).strict() }),
  asyncHandler(async (req, res) => {
    const c = await confirmReturn(req.validated.params.id, req.user!, req.validated.body.note);
    ok(res, (await presentForAdmin([c]))[0]);
  }),
);

adminReturnsRouter.post(
  "/:id/reject",
  validate({ params: idParams, body: z.object({ reason: z.string().trim().min(3, "Say why, so the customer knows").max(500) }).strict() }),
  asyncHandler(async (req, res) => {
    const c = await rejectReturn(req.validated.params.id, req.user!, req.validated.body.reason);
    ok(res, (await presentForAdmin([c]))[0]);
  }),
);

adminReturnsRouter.post(
  "/:id/complete",
  validate({
    params: idParams,
    body: z
      .object({
        refundKobo: kobo.max(10_000_000_000),
        note: z.string().trim().max(300).optional(),
        restock: z.boolean().default(false),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const c = await completeReturn(req.validated.params.id, req.user!, req.validated.body);
    ok(res, (await presentForAdmin([c]))[0]);
  }),
);
