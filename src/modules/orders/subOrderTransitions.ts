import type { Types } from "mongoose";
import { holdHasEnded, unlockedBefore } from "../../domain/earnings.js";
import { assertTransition, TransitionError, type Actor, type OrderStatus } from "../../domain/orderStateMachine.js";
import { Order } from "../../models/Order.js";
import { StatusLog } from "../../models/StatusLog.js";
import { SubOrder, type SubOrderDoc } from "../../models/SubOrder.js";
import { AppError } from "../../utils/AppError.js";
import { notifySubOrderEvent, type SubOrderEvent } from "./orderEvents.js";
import { releaseStock } from "./orders.service.js";

export interface TransitionActor {
  role: Actor;
  userId?: Types.ObjectId;
}

export interface TransitionOptions {
  note?: string;
  /** Required by FAILED_DELIVERY. */
  reason?: string;
  now?: Date;
}

/** Which statuses tell people something. PAID is announced once per order by the webhook instead. */
const EVENT_FOR: Partial<Record<OrderStatus, SubOrderEvent>> = {
  READY_FOR_PICKUP: "READY_FOR_PICKUP",
  PICKED_UP: "PICKED_UP",
  DELIVERED: "DELIVERED",
  FAILED_DELIVERY: "FAILED_DELIVERY",
  CANCELLED: "CANCELLED",
  COMPLETED: "COMPLETED",
};

/**
 * The only door through which a paid sub-order changes status. It:
 *   1. checks the state machine (is this move allowed, for this kind of actor),
 *   2. applies it with a guarded update (`status` must still be what we read), so two people clicking at
 *      once cannot both succeed,
 *   3. writes the log row (who, when, why), records timestamps like deliveredAt,
 *   4. returns stock and flags a refund when an admin cancels paid goods,
 *   5. tells the customer and vendor (best effort, never blocks the change).
 * Callers are responsible for checking the actor may touch THIS sub-order (own vendor, assigned handler).
 */
export async function transitionSubOrder(subOrderId: unknown, to: OrderStatus, actor: TransitionActor, opts: TransitionOptions = {}): Promise<SubOrderDoc> {
  const sub = await SubOrder.findById(subOrderId);
  if (!sub) throw AppError.notFound("Order not found");
  const from = sub.status;

  try {
    assertTransition(from, to, actor.role);
  } catch (err) {
    if (err instanceof TransitionError) throw AppError.conflict(`This order is ${labelOf(from)}, so it cannot be marked ${labelOf(to)}.`);
    throw err;
  }
  if (to === "FAILED_DELIVERY" && !opts.reason?.trim()) throw AppError.validation("Say why the delivery failed", [{ path: "reason", message: "Say why the delivery failed" }]);

  const now = opts.now ?? new Date();
  const set: Record<string, unknown> = { status: to };
  const unset: Record<string, 1> = {};
  if (to === "DELIVERED") set.deliveredAt = now;
  if (to === "COMPLETED") set.completedAt = now;
  if (to === "FAILED_DELIVERY") set.failureReason = opts.reason!.trim();
  if (from === "FAILED_DELIVERY" && to === "PICKED_UP") unset.failureReason = 1; // a retry starts clean

  const updated = await SubOrder.findOneAndUpdate({ _id: sub._id, status: from }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { returnDocument: "after" });
  if (!updated) throw AppError.conflict("This order was just changed by someone else. Refresh and try again.");

  await StatusLog.create({
    subOrderId: sub._id,
    orderId: sub.orderId,
    from,
    to,
    actorId: actor.userId,
    actorRole: actor.role,
    note: opts.note ?? opts.reason?.trim(),
    at: now,
  });

  if (to === "CANCELLED") {
    // The goods never left: put them back on the shelf. The customer already paid, so a human must refund.
    await releaseStock(updated.items.map((i) => ({ productId: String(i.productId), qty: i.qty })));
    await Order.updateOne(
      { _id: sub.orderId },
      {
        needsAttention: true,
        attentionReason: `${sub.ref} was cancelled after payment. Refund ${(updated.itemsTotalKobo + updated.delivery!.feeKobo) / 100} naira (items and delivery) to the customer in Paystack.`,
      },
    );
  }

  const event = EVENT_FOR[to];
  if (event) await notifySubOrderEvent(updated, event, { actorId: actor.userId ? String(actor.userId) : undefined, reason: updated.failureReason ?? undefined });
  return updated;
}

/**
 * Delivered orders become COMPLETED once the 4 working day hold has passed (the same moment vendor earnings
 * unlock). Called by the sweeper; safe to run any number of times.
 */
export async function completeDeliveredOrders(now = new Date()): Promise<number> {
  const cutoff = unlockedBefore(now);
  const due = await SubOrder.find({ status: "DELIVERED", deliveredAt: { $lte: cutoff } }).limit(200);
  let done = 0;
  for (const sub of due) {
    if (!sub.deliveredAt || !holdHasEnded(sub.deliveredAt, now)) continue;
    try {
      await transitionSubOrder(sub._id, "COMPLETED", { role: "SYSTEM" }, { now, note: "Hold passed (4 working days after delivery)" });
      done++;
    } catch (err) {
      // Someone else completed or changed it first; nothing to do.
      if (!(err instanceof AppError)) throw err;
    }
  }
  return done;
}

const LABELS: Record<OrderStatus, string> = {
  PENDING_PAYMENT: "waiting for payment",
  PAID: "paid and waiting to be packed",
  READY_FOR_PICKUP: "ready for pickup",
  PICKED_UP: "out for delivery",
  DELIVERED: "delivered",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  FAILED_DELIVERY: "a failed delivery",
};
const labelOf = (s: OrderStatus) => LABELS[s];
