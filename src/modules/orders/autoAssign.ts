import type { Types } from "mongoose";
import { chooseHandler } from "../../domain/handlerChoice.js";
import type { OrderStatus } from "../../domain/orderStateMachine.js";
import { getAutoAssign } from "../../models/Settings.js";
import { SubOrder, type SubOrderDoc } from "../../models/SubOrder.js";
import { User, type UserDoc } from "../../models/User.js";
import { notifySubOrderEvent } from "./orderEvents.js";

/** A parcel counts against a handler until it is delivered, cancelled or completed. */
const OPEN: OrderStatus[] = ["PAID", "READY_FOR_PICKUP", "PICKED_UP", "FAILED_DELIVERY"];
/** A handler can be given a delivery until it is on the road. Same rule as assigning by hand. */
const ASSIGNABLE: OrderStatus[] = ["PAID", "READY_FOR_PICKUP", "FAILED_DELIVERY"];

/** Every active delivery handler with how many deliveries they hold, for the admin's dropdown and for choosing one automatically. */
export async function handlerLoads(): Promise<{ handler: UserDoc; open: number; total: number }[]> {
  const handlers = await User.find({ role: "HANDLER", isActive: true }).sort({ name: 1 });
  if (handlers.length === 0) return [];
  const rows = await SubOrder.aggregate<{ _id: Types.ObjectId; total: number; open: number }>([
    { $match: { handlerId: { $in: handlers.map((h) => h._id) } } },
    { $group: { _id: "$handlerId", total: { $sum: 1 }, open: { $sum: { $cond: [{ $in: ["$status", OPEN] }, 1, 0] } } } },
  ]);
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  return handlers.map((handler) => ({ handler, open: byId.get(String(handler._id))?.open ?? 0, total: byId.get(String(handler._id))?.total ?? 0 }));
}

/**
 * Gives one waiting delivery to the handler with the lightest load, whatever the setting says. The update only applies to a
 * delivery that has no handler yet, so it can never take a delivery away from someone the admin chose, and two runs at once
 * cannot both assign it. Returns the updated delivery, or null when nothing changed (no handler, already assigned, on the road).
 */
async function assignBest(subOrderId: Types.ObjectId | string): Promise<SubOrderDoc | null> {
  const loads = await handlerLoads();
  const chosen = chooseHandler(loads.map((l) => ({ id: String(l.handler._id), open: l.open, total: l.total })));
  if (!chosen) return null;
  const sub = await SubOrder.findOneAndUpdate({ _id: subOrderId, status: { $in: ASSIGNABLE }, handlerId: { $exists: false } }, { handlerId: chosen }, { returnDocument: "after" });
  if (!sub) return null;
  await notifySubOrderEvent(sub, "ASSIGNED", {});
  return sub;
}

/** Assigns a delivery if the super admin has switched automatic assignment on. */
export async function autoAssign(subOrderId: Types.ObjectId | string): Promise<SubOrderDoc | null> {
  if (!(await getAutoAssign())) return null;
  return assignBest(subOrderId);
}

/**
 * Gives every paid delivery that is still waiting for a handler to one, oldest first, one at a time so each choice sees the
 * last. Run when automatic assignment is switched on and from the periodic sweep, so a delivery that found no handler (none
 * had been created yet) is picked up as soon as there is one. Returns how many were assigned.
 */
export async function autoAssignWaiting(limit = 200): Promise<number> {
  if (!(await getAutoAssign())) return 0;
  const waiting = await SubOrder.find({ status: { $in: ["PAID", "READY_FOR_PICKUP"] }, handlerId: { $exists: false } })
    .sort({ paidAt: 1, createdAt: 1 })
    .limit(limit)
    .select("_id");
  let assigned = 0;
  for (const sub of waiting) if (await assignBest(sub._id)) assigned++;
  return assigned;
}
