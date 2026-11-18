import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";
import { objectId, pagination } from "../../utils/zodCommon.js";
import type { OrderStatus } from "../../domain/orderStateMachine.js";
import { netEarningKobo } from "../../domain/returns.js";
import { SubOrder, type SubOrderDoc } from "../../models/SubOrder.js";
import { User } from "../../models/User.js";
import { transitionSubOrder } from "../orders/subOrderTransitions.js";
import { getVendorForUser } from "./vendor.service.js";

// Mounted under /api/vendor/orders, behind requireRole("VENDOR"). Every query is scoped to this vendor.
export const vendorOrdersRouter = Router();

/** The tabs on the orders page. Unpaid and expired orders are never shown to the vendor. */
export const VENDOR_GROUPS = {
  todo: ["PAID"],
  active: ["READY_FOR_PICKUP", "PICKED_UP"],
  done: ["DELIVERED", "COMPLETED"],
  problem: ["CANCELLED", "FAILED_DELIVERY"],
} as const satisfies Record<string, OrderStatus[]>;
type Group = keyof typeof VENDOR_GROUPS;

const ALL_VISIBLE: OrderStatus[] = Object.values(VENDOR_GROUPS).flat();

/** What a vendor needs to fill the order: items and money. Not the customer's address, phone or email. */
async function present(subs: SubOrderDoc[]) {
  const customers = await User.find({ _id: { $in: subs.map((s) => s.customerId) } }).select("name");
  const handlers = await User.find({ _id: { $in: subs.map((s) => s.handlerId).filter(Boolean) } }).select("name");
  const firstName = (n?: string) => n?.split(" ")[0] ?? null;
  const cMap = new Map(customers.map((c) => [String(c._id), c.name]));
  const hMap = new Map(handlers.map((h) => [String(h._id), h.name]));
  return subs.map((s) => ({
    id: String(s._id),
    ref: s.ref,
    status: s.status,
    paidAt: s.paidAt ?? null,
    deliveredAt: s.deliveredAt ?? null,
    customerFirstName: firstName(cMap.get(String(s.customerId))),
    handlerFirstName: s.handlerId ? firstName(hMap.get(String(s.handlerId))) : null,
    items: s.items.map((i) => ({ name: i.name, image: i.image ?? null, qty: i.qty, unitPriceKobo: i.unitPriceKobo, lineTotalKobo: i.lineTotalKobo, commissionKobo: i.commissionKobo, vendorEarningKobo: i.vendorEarningKobo })),
    itemsTotalKobo: s.itemsTotalKobo,
    commissionTotalKobo: s.commissionTotalKobo,
    vendorEarningKobo: s.vendorEarningKobo,
    // A return or problem report is open on this delivery, so its earnings stay on hold until it is settled.
    returnHold: s.returnHold ?? false,
    // Taken off by refunds, and what is left.
    returnedEarningKobo: s.returnedEarningKobo ?? 0,
    netEarningKobo: netEarningKobo(s.vendorEarningKobo, s.returnedEarningKobo),
    failureReason: s.failureReason ?? null,
  }));
}

vendorOrdersRouter.get(
  "/",
  validate({ query: pagination.extend({ group: z.enum(["todo", "active", "done", "problem"]).default("todo") }) }),
  asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user!._id);
    const { group, page, limit } = req.validated.query as { group: Group; page: number; limit: number };
    const filter = { vendorId: vendor._id, status: { $in: [...VENDOR_GROUPS[group]] } };

    const [subs, total, counts] = await Promise.all([
      SubOrder.find(filter)
        .sort({ paidAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      SubOrder.countDocuments(filter),
      Promise.all(
        (Object.keys(VENDOR_GROUPS) as Group[]).map(async (g) => [g, await SubOrder.countDocuments({ vendorId: vendor._id, status: { $in: [...VENDOR_GROUPS[g]] } })] as const),
      ),
    ]);
    // `counts` feeds the tab badges and the sidebar number.
    ok(res, { counts: Object.fromEntries(counts), orders: await present(subs) }, { page, limit, total });
  }),
);

vendorOrdersRouter.post(
  "/:id/ready",
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user!._id);
    if (vendor.status === "SUSPENDED") throw AppError.forbidden("Your store is suspended. Contact support.");
    // Another vendor's order looks exactly like a missing one.
    const sub = await SubOrder.findOne({ _id: req.validated.params.id, vendorId: vendor._id, status: { $in: ALL_VISIBLE } });
    if (!sub) throw AppError.notFound("Order not found");
    const updated = await transitionSubOrder(sub._id, "READY_FOR_PICKUP", { role: "VENDOR", userId: req.user!._id });
    ok(res, (await present([updated]))[0]);
  }),
);
