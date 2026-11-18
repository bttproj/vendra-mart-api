import type { Types } from "mongoose";
import {
  LODGE_WINDOW_HOURS,
  OPEN_RETURN_STATUSES,
  REFUND_WORKING_DAYS,
  RETURN_REASON_LABELS,
  canLodge,
  lodgeDeadline,
  maxRefundKobo,
  refundDeadline,
  returnedEarningKobo,
  type ReturnReason,
  type ReturnType,
} from "../../domain/returns.js";
import { sumKobo } from "../../domain/money.js";
import { nextSeq } from "../../models/Counter.js";
import { Product } from "../../models/Product.js";
import { ReturnRequest, type ReturnRequestDoc } from "../../models/ReturnRequest.js";
import { SubOrder } from "../../models/SubOrder.js";
import { User, type UserDoc } from "../../models/User.js";
import { Vendor } from "../../models/Vendor.js";
import { getNotifier, type NotificationMessage } from "../../services/notifications/index.js";
import { AppError } from "../../utils/AppError.js";
import { formatNaira } from "../../utils/formatNaira.js";
import { orderPage } from "../../utils/webLinks.js";
import { notifyTeam } from "../accounts/team.js";

const DELIVERED = ["DELIVERED", "COMPLETED"] as const;
const RETURN_NUMBER_START = 1000;

export interface LodgeInput {
  subOrderId: string;
  type: ReturnType;
  reason: ReturnReason;
  description: string;
  items: { productId: string; qty: number }[];
}

/** Keeps a delivery's earnings on hold while a case is open on it, and lets them go when none is. */
export async function recomputeReturnHold(subOrderId: Types.ObjectId | string): Promise<void> {
  const open = await ReturnRequest.exists({ subOrderId, status: { $in: [...OPEN_RETURN_STATUSES] } });
  await SubOrder.updateOne({ _id: subOrderId }, { returnHold: Boolean(open) });
}

const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Africa/Lagos" });

/** Tells one person in the app and by email. Never throws: a mail problem must not undo a decision. */
async function tell(userId: Types.ObjectId | string, message: NotificationMessage, channels: "all" | "in-app" = "all"): Promise<void> {
  try {
    const user = await User.findById(userId);
    if (!user) return;
    await getNotifier().notify([{ id: String(user._id), name: user.name, email: user.email }], message, { channels });
  } catch (err) {
    console.error("Return notification failed:", (err as Error).message);
  }
}

async function tellVendor(vendorId: Types.ObjectId, message: NotificationMessage): Promise<void> {
  const vendor = await Vendor.findById(vendorId);
  if (vendor) await tell(vendor.userId, message, "in-app");
}

/**
 * A customer lodges a return or a problem report on part of a delivery. Only for a delivery that has arrived, only within
 * 48 hours of it (the Return and Refund Policy), one open case per delivery at a time, and only for units not already refunded.
 * The delivery's earnings go on hold while it is open.
 */
export async function lodgeReturn(customer: UserDoc, input: LodgeInput, now = new Date()): Promise<ReturnRequestDoc> {
  const sub = await SubOrder.findOne({ _id: input.subOrderId, customerId: customer._id });
  if (!sub) throw AppError.notFound("Delivery not found");
  if (!(DELIVERED as readonly string[]).includes(sub.status)) throw AppError.forbidden("You can return or report an item once it has been delivered to you.");
  if (!sub.deliveredAt || !canLodge(sub.deliveredAt, now)) {
    throw AppError.conflict(`The ${LODGE_WINDOW_HOURS} hour window to return or report this delivery has passed. Please contact support.`);
  }
  if (await ReturnRequest.exists({ subOrderId: sub._id, status: { $in: [...OPEN_RETURN_STATUSES] } })) {
    throw AppError.conflict("You already have an open return or report for this delivery. Wait for our answer, or cancel it first.");
  }

  const wanted = new Map<string, number>();
  for (const i of input.items) {
    if (wanted.has(i.productId)) throw AppError.validation("List each item once", [{ path: "items", message: "List each item once" }]);
    wanted.set(i.productId, i.qty);
  }

  // Units already refunded in earlier, completed cases cannot be returned again.
  const earlier = await ReturnRequest.find({ subOrderId: sub._id, status: "COMPLETED" });
  const done = new Map<string, number>();
  for (const c of earlier) for (const i of c.items) done.set(String(i.productId), (done.get(String(i.productId)) ?? 0) + i.qty);

  const lines = [];
  for (const [productId, qty] of wanted) {
    const line = sub.items.find((l) => String(l.productId) === productId);
    if (!line) throw AppError.validation("That item is not in this delivery", [{ path: "items", message: "That item is not in this delivery" }]);
    const returnable = line.qty - (done.get(productId) ?? 0);
    if (qty > returnable) {
      throw AppError.validation(returnable > 0 ? `Only ${returnable} of ${line.name} can be returned` : `${line.name} has already been refunded`, [{ path: "items", message: "Too many" }]);
    }
    lines.push({
      productId: line.productId,
      name: line.name,
      qty,
      unitPriceKobo: line.unitPriceKobo,
      lineTotalKobo: line.unitPriceKobo * qty,
      vendorEarningKobo: returnedEarningKobo(line.vendorEarningKobo, line.qty, qty),
    });
  }
  const wholeDelivery = sub.items.every((l) => (done.get(String(l.productId)) ?? 0) + (wanted.get(String(l.productId)) ?? 0) === l.qty);

  const created = await ReturnRequest.create({
    number: `RT-${await nextSeq("return", RETURN_NUMBER_START)}`,
    customerId: customer._id,
    orderId: sub.orderId,
    orderNumber: sub.orderNumber,
    subOrderId: sub._id,
    subOrderRef: sub.ref,
    vendorId: sub.vendorId,
    type: input.type,
    reason: input.reason,
    description: input.description,
    items: lines,
    wholeDelivery,
  });
  await SubOrder.updateOne({ _id: sub._id }, { returnHold: true });

  const what = input.type === "RETURN" ? "a return" : "a problem report";
  await notifyTeam(
    "orders",
    { kind: "RETURN_REQUESTED", title: `${created.number}: ${what} needs a decision`, body: `${customer.name} lodged ${what} on ${sub.ref} (${RETURN_REASON_LABELS[input.reason]}). Confirm or reject it.`, link: "/admin/returns" },
    { vendorDesk: true },
  );
  await tellVendor(sub.vendorId, {
    kind: "RETURN_REQUESTED",
    title: `${what[0]!.toUpperCase()}${what.slice(1)} was lodged on ${sub.ref}`,
    body: "Your earnings for this order stay on hold until it is settled. Our team will look into it.",
    link: "/vendor/orders",
  });
  return created;
}

/** The customer withdraws a case that has not been decided yet. */
export async function cancelReturn(customerId: Types.ObjectId, id: string): Promise<ReturnRequestDoc> {
  const cancelled = await ReturnRequest.findOneAndUpdate({ _id: id, customerId, status: "REQUESTED" }, { status: "CANCELLED", cancelledAt: new Date() }, { returnDocument: "after" });
  if (!cancelled) {
    if (!(await ReturnRequest.exists({ _id: id, customerId }))) throw AppError.notFound("Return not found");
    throw AppError.conflict("This can only be cancelled while it is waiting for our decision.");
  }
  await recomputeReturnHold(cancelled.subOrderId);
  return cancelled;
}

/** The admin accepts a case. The refund is now due within 7 working days. */
export async function confirmReturn(id: string, admin: UserDoc, note: string | undefined, now = new Date()): Promise<ReturnRequestDoc> {
  const windowEndsAt = refundDeadline(now);
  const confirmed = await ReturnRequest.findOneAndUpdate(
    { _id: id, status: "REQUESTED" },
    { status: "CONFIRMED", confirmedAt: now, windowEndsAt, decidedBy: admin._id, ...(note ? { decisionNote: note } : {}) },
    { returnDocument: "after" },
  );
  if (!confirmed) throw await notDecidable(id, "REQUESTED");

  await tell(confirmed.customerId, {
    kind: "RETURN_CONFIRMED",
    title: `${confirmed.number} is confirmed`,
    body: `Your ${confirmed.type === "RETURN" ? "return" : "report"} on ${confirmed.subOrderRef} was accepted. Keep the item ready: our team will arrange collection. Your refund will be made within ${REFUND_WORKING_DAYS} working days, by ${day(windowEndsAt)}.${note ? ` Note from us: ${note}` : ""}`,
    link: orderPage(confirmed.orderId),
  });
  await tellVendor(confirmed.vendorId, { kind: "RETURN_CONFIRMED", title: `A return on ${confirmed.subOrderRef} was confirmed`, body: `It will be settled by ${day(windowEndsAt)}. Your earnings for this order stay on hold until then.`, link: "/vendor/orders" });
  return confirmed;
}

/** The admin turns a case down, before or after confirming it (for example the item came back unfit). A reason is required. */
export async function rejectReturn(id: string, admin: UserDoc, reason: string, now = new Date()): Promise<ReturnRequestDoc> {
  const rejected = await ReturnRequest.findOneAndUpdate({ _id: id, status: { $in: [...OPEN_RETURN_STATUSES] } }, { status: "REJECTED", rejectedAt: now, decisionNote: reason, decidedBy: admin._id }, { returnDocument: "after" });
  if (!rejected) throw await notDecidable(id, "REQUESTED or CONFIRMED");
  await recomputeReturnHold(rejected.subOrderId);

  await tell(rejected.customerId, {
    kind: "RETURN_REJECTED",
    title: `${rejected.number} was not accepted`,
    body: `We could not accept your ${rejected.type === "RETURN" ? "return" : "report"} on ${rejected.subOrderRef}. Reason: ${reason}. If you disagree, please contact support.`,
    link: orderPage(rejected.orderId),
  });
  await tellVendor(rejected.vendorId, { kind: "RETURN_REJECTED", title: `A return on ${rejected.subOrderRef} was closed`, body: "It was not accepted, so your earnings for this order are released as usual.", link: "/vendor/orders" });
  return rejected;
}

export interface CompleteInput {
  refundKobo: number;
  note?: string;
  /** Put the returned units back on sale (and take them off the sold count). */
  restock: boolean;
}

/**
 * The admin settles a confirmed case: the refund has been made (manually, in Paystack) and is recorded here. The refunded
 * items' share of the vendor's earnings comes off, and the delivery's hold is released if nothing else is open on it.
 */
export async function completeReturn(id: string, admin: UserDoc, input: CompleteInput, now = new Date()): Promise<ReturnRequestDoc> {
  const current = await ReturnRequest.findById(id);
  if (!current) throw AppError.notFound("Return not found");
  if (current.status !== "CONFIRMED") throw AppError.conflict(`This case is ${current.status.toLowerCase()}, so it cannot be completed. Only a confirmed case can.`);

  const sub = await SubOrder.findById(current.subOrderId);
  if (!sub) throw AppError.notFound("Delivery not found");
  const goods = sumKobo(current.items.map((i) => i.lineTotalKobo));
  const ceiling = maxRefundKobo(goods, sub.delivery!.feeKobo, current.wholeDelivery ?? false);
  if (input.refundKobo < 1 || input.refundKobo > ceiling) {
    throw AppError.validation(`The refund must be from ${formatNaira(1)} to ${formatNaira(ceiling)}`, [{ path: "refundKobo", message: `Enter an amount up to ${formatNaira(ceiling)}` }]);
  }

  const completed = await ReturnRequest.findOneAndUpdate(
    { _id: id, status: "CONFIRMED" },
    { status: "COMPLETED", completedAt: now, refundKobo: input.refundKobo, restocked: input.restock, decidedBy: admin._id, ...(input.note ? { refundNote: input.note } : {}) },
    { returnDocument: "after" },
  );
  if (!completed) throw await notDecidable(id, "CONFIRMED");

  const takenOff = sumKobo(completed.items.map((i) => i.vendorEarningKobo));
  await SubOrder.updateOne({ _id: completed.subOrderId }, { $inc: { returnedEarningKobo: takenOff } });
  if (input.restock) {
    for (const i of completed.items) {
      await Product.updateOne({ _id: i.productId }, { $inc: { stock: i.qty } }).catch(() => {});
      await Product.updateOne({ _id: i.productId, soldCount: { $gte: i.qty } }, { $inc: { soldCount: -i.qty } }).catch(() => {});
    }
  }
  await recomputeReturnHold(completed.subOrderId);

  await tell(completed.customerId, {
    kind: "RETURN_COMPLETED",
    title: `Your refund for ${completed.number} is on its way`,
    body: `We refunded ${formatNaira(input.refundKobo)} for ${completed.subOrderRef} to your original payment method. Your bank may take a few more days to show it.${input.note ? ` Note: ${input.note}` : ""}`,
    link: orderPage(completed.orderId),
  });
  await tellVendor(completed.vendorId, { kind: "RETURN_COMPLETED", title: `A return on ${completed.subOrderRef} was refunded`, body: `${formatNaira(takenOff)} was taken off your earnings for this order. The rest is released as usual.`, link: "/vendor/earnings" });
  return completed;
}

async function notDecidable(id: string, wanted: string): Promise<AppError> {
  const found = await ReturnRequest.findById(id).select("status");
  return found ? AppError.conflict(`This case is ${found.status.toLowerCase()}, so that cannot be done now. It has to be ${wanted.toLowerCase()}.`) : AppError.notFound("Return not found");
}

/**
 * Tells the team, once, about each confirmed case whose 7 working day refund deadline has passed without being completed, so a refund is
 * not forgotten. Run from the periodic sweep. Returns how many it flagged.
 */
export async function flagOverdueReturns(now = new Date()): Promise<number> {
  const late = await ReturnRequest.find({ status: "CONFIRMED", windowEndsAt: { $lt: now }, overdueNotifiedAt: { $exists: false } }).limit(100);
  let flagged = 0;
  for (const c of late) {
    const claimed = await ReturnRequest.findOneAndUpdate({ _id: c._id, status: "CONFIRMED", overdueNotifiedAt: { $exists: false } }, { overdueNotifiedAt: now });
    if (!claimed) continue;
    flagged++;
    await notifyTeam("orders", { kind: "RETURN_OVERDUE", title: `${c.number} is past its ${REFUND_WORKING_DAYS} working day refund deadline`, body: `${c.subOrderRef} was confirmed but the refund was not recorded in time. Finish it, or tell the customer why it is late.`, link: "/admin/returns" });
  }
  return flagged;
}

export { lodgeDeadline };
