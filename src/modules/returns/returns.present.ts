import { RETURN_REASON_LABELS, windowState, workingDaysLeft } from "../../domain/returns.js";
import type { ReturnRequestDoc } from "../../models/ReturnRequest.js";

/** A case as the customer sees it, and as the base of what the admin sees. */
export function presentReturn(r: ReturnRequestDoc, now = new Date()) {
  const state = windowState({ status: r.status, windowEndsAt: r.windowEndsAt }, now);
  return {
    id: String(r._id),
    number: r.number,
    orderId: String(r.orderId),
    orderNumber: r.orderNumber,
    subOrderId: String(r.subOrderId),
    subOrderRef: r.subOrderRef,
    type: r.type,
    reason: r.reason,
    reasonLabel: RETURN_REASON_LABELS[r.reason],
    description: r.description,
    status: r.status,
    items: r.items.map((i) => ({ productId: String(i.productId), name: i.name, qty: i.qty, lineTotalKobo: i.lineTotalKobo })),
    goodsKobo: r.items.reduce((n, i) => n + i.lineTotalKobo, 0),
    // The admin's note on confirming, or the reason it was turned down.
    decisionNote: r.decisionNote ?? null,
    createdAt: r.createdAt,
    confirmedAt: r.confirmedAt ?? null,
    // A confirmed case must be refunded within 7 working days: this is the deadline.
    windowEndsAt: r.windowEndsAt ?? null,
    windowState: state, // NONE (not confirmed), OPEN, or ENDED (past the deadline without being refunded)
    windowWorkingDaysLeft: state === "OPEN" && r.windowEndsAt ? workingDaysLeft(r.windowEndsAt, now) : null,
    completedAt: r.completedAt ?? null,
    refundKobo: r.refundKobo ?? null,
  };
}
