import { Router } from "express";
import { z } from "zod";
import type { OrderStatus } from "../../domain/orderStateMachine.js";
import { requireSuperAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";
import { escapeRegex, objectId, pagination } from "../../utils/zodCommon.js";
import { getAutoAssign, getPricing, Settings } from "../../models/Settings.js";
import { SubOrder, type SubOrderDoc } from "../../models/SubOrder.js";
import { User } from "../../models/User.js";
import { Vendor } from "../../models/Vendor.js";
import { autoAssignWaiting, handlerLoads } from "../orders/autoAssign.js";
import { notifySubOrderEvent } from "../orders/orderEvents.js";
import { transitionSubOrder } from "../orders/subOrderTransitions.js";

// Mounted under /api/admin, behind requireRole("ADMIN").
export const adminDeliveriesRouter = Router();

const FROM_PAID: OrderStatus[] = ["PAID", "READY_FOR_PICKUP", "PICKED_UP", "DELIVERED", "COMPLETED", "CANCELLED", "FAILED_DELIVERY"];

/** A handler can be (re)assigned until the parcel is on the road. */
const ASSIGNABLE: OrderStatus[] = ["PAID", "READY_FOR_PICKUP", "FAILED_DELIVERY"];

const GROUPS: Record<string, { status?: OrderStatus[]; unassigned?: boolean }> = {
  needs_handler: { status: ["PAID", "READY_FOR_PICKUP", "FAILED_DELIVERY"], unassigned: true },
  active: { status: ["PAID", "READY_FOR_PICKUP", "PICKED_UP"] },
  problem: { status: ["FAILED_DELIVERY", "CANCELLED"] },
  done: { status: ["DELIVERED", "COMPLETED"] },
  all: {},
};

async function present(subs: SubOrderDoc[]) {
  const [vendors, customers, handlers] = await Promise.all([
    Vendor.find({ _id: { $in: subs.map((s) => s.vendorId) } }).select("businessName"),
    User.find({ _id: { $in: subs.map((s) => s.customerId) } }).select("name"),
    User.find({ _id: { $in: subs.map((s) => s.handlerId).filter(Boolean) } }).select("name"),
  ]);
  const v = new Map(vendors.map((x) => [String(x._id), x.businessName]));
  const c = new Map(customers.map((x) => [String(x._id), x.name]));
  const h = new Map(handlers.map((x) => [String(x._id), x.name]));
  return subs.map((s) => ({
    id: String(s._id),
    ref: s.ref,
    orderNumber: s.orderNumber,
    status: s.status,
    vendorName: v.get(String(s.vendorId)) ?? "Vendor",
    customerName: c.get(String(s.customerId)) ?? "Customer",
    handler: s.handlerId ? { id: String(s.handlerId), name: h.get(String(s.handlerId)) ?? "Handler" } : null,
    pickupLine: s.delivery!.pickup!.line,
    dropoffLine: s.delivery!.dropoff!.line,
    distanceKm: (Math.round(s.delivery!.distanceMeters / 100) / 10).toFixed(1),
    feeKobo: s.delivery!.feeKobo,
    itemsTotalKobo: s.itemsTotalKobo,
    itemCount: s.items.reduce((n, i) => n + i.qty, 0),
    paidAt: s.paidAt ?? null,
    deliveredAt: s.deliveredAt ?? null,
    failureReason: s.failureReason ?? null,
  }));
}

adminDeliveriesRouter.get(
  "/deliveries",
  validate({ query: pagination.extend({ group: z.enum(["needs_handler", "active", "problem", "done", "all"]).default("needs_handler"), q: z.string().trim().max(60).optional() }) }),
  asyncHandler(async (req, res) => {
    const { group, page, limit, q } = req.validated.query as { group: string; page: number; limit: number; q?: string };
    const rule = GROUPS[group]!;
    const base: Record<string, unknown> = { status: { $in: rule.status ?? FROM_PAID } };
    if (rule.unassigned) base.handlerId = { $exists: false };
    const filter = q ? { ...base, $or: [{ ref: new RegExp(escapeRegex(q), "i") }, { orderNumber: new RegExp(escapeRegex(q), "i") }] } : base;

    const [subs, total, counts] = await Promise.all([
      SubOrder.find(filter)
        .sort({ paidAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      SubOrder.countDocuments(filter),
      Promise.all(
        Object.entries(GROUPS).map(async ([g, r]) => {
          const f: Record<string, unknown> = { status: { $in: r.status ?? FROM_PAID } };
          if (r.unassigned) f.handlerId = { $exists: false };
          return [g, await SubOrder.countDocuments(f)] as const;
        }),
      ),
    ]);
    ok(res, { counts: Object.fromEntries(counts), autoAssign: await getAutoAssign(), deliveries: await present(subs) }, { page, limit, total });
  }),
);

// The "Choose a handler" list: delivery handlers only (never administrators), active ones, with what each is carrying now.
// Its own route, so a person who may open deliveries does not also need the staff area to assign one.
adminDeliveriesRouter.get(
  "/deliveries/handlers",
  asyncHandler(async (_req, res) => {
    const loads = await handlerLoads();
    ok(res, loads.map((l) => ({ id: String(l.handler._id), name: l.handler.name, openDeliveries: l.open })));
  }),
);

// Automatic or manual assignment, switched by the super admin like the NIN rule. Switching it on also gives the deliveries
// already waiting for a handler to one, so nothing is left behind.
adminDeliveriesRouter.put(
  "/deliveries/assignment",
  requireSuperAdmin,
  validate({ body: z.object({ autoAssign: z.boolean() }).strict() }),
  asyncHandler(async (req, res) => {
    const { autoAssign } = req.validated.body;
    await getPricing(); // make sure the settings document exists
    await Settings.updateOne({ key: "singleton" }, { $set: { autoAssignHandlers: autoAssign, updatedBy: req.user!._id } });
    const assignedNow = autoAssign ? await autoAssignWaiting() : 0;
    ok(res, { autoAssign, assignedNow });
  }),
);

adminDeliveriesRouter.post(
  "/sub-orders/:id/assign",
  validate({ params: z.object({ id: objectId }), body: z.object({ handlerId: objectId }).strict() }),
  asyncHandler(async (req, res) => {
    const handler = await User.findOne({ _id: req.validated.body.handlerId, role: "HANDLER" });
    if (!handler) throw AppError.validation("Pick a delivery handler", [{ path: "handlerId", message: "Pick a delivery handler" }]);
    if (!handler.isActive) throw AppError.validation("That handler's account is deactivated", [{ path: "handlerId", message: "That handler is deactivated" }]);

    // Guarded on status, so a parcel that was just picked up cannot be re-assigned underneath the rider.
    const sub = await SubOrder.findOneAndUpdate({ _id: req.validated.params.id, status: { $in: ASSIGNABLE } }, { handlerId: handler._id }, { returnDocument: "after" });
    if (!sub) {
      const exists = await SubOrder.exists({ _id: req.validated.params.id });
      if (!exists) throw AppError.notFound("Order not found");
      throw AppError.conflict("A handler can only be assigned before the parcel is picked up, and only after it is paid.");
    }
    await notifySubOrderEvent(sub, "ASSIGNED", { actorId: String(req.user!._id) });
    ok(res, (await present([sub]))[0]);
  }),
);

// The admin's own moves: cancel a paid delivery, or retry one that failed. The state machine decides what is allowed.
adminDeliveriesRouter.post(
  "/sub-orders/:id/status",
  validate({ params: z.object({ id: objectId }), body: z.object({ to: z.enum(["CANCELLED", "PICKED_UP"]), note: z.string().trim().max(300).optional() }).strict() }),
  asyncHandler(async (req, res) => {
    const updated = await transitionSubOrder(req.validated.params.id, req.validated.body.to, { role: "ADMIN", userId: req.user!._id }, { note: req.validated.body.note });
    ok(res, (await present([updated]))[0]);
  }),
);
