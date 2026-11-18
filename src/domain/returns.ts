// Returns and problem reports. Pure functions and constants (no I/O), unit tested.
//
// A customer lodges a case within 2 days (48 hours) of delivery: the return window in the Return and Refund Policy. An admin
// confirms or rejects it. A confirmed case must be refunded within 7 working days (Monday to Friday, Lagos time): the item
// comes back and the admin records the refund inside that time. While a case is open, the vendor's earnings for that delivery
// stay on hold, and a refund takes the refunded items' earnings off them.

import { addWorkingDays } from "./earnings.js";
import { divRoundHalfUp } from "./money.js";

export const RETURN_TYPES = ["RETURN", "REPORT"] as const;
/** RETURN: the customer wants to send the item back for a refund. REPORT: something is wrong and they want it looked into. */
export type ReturnType = (typeof RETURN_TYPES)[number];

export const RETURN_REASONS = ["DAMAGED", "DEFECTIVE", "WRONG_ITEM", "NOT_AS_DESCRIBED", "NOT_RECEIVED", "CHANGED_MIND", "OTHER"] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  DAMAGED: "Arrived damaged",
  DEFECTIVE: "Does not work or is faulty",
  WRONG_ITEM: "Wrong item sent",
  NOT_AS_DESCRIBED: "Not as described",
  NOT_RECEIVED: "Marked delivered but I did not receive it",
  CHANGED_MIND: "I changed my mind",
  OTHER: "Something else",
};

export const RETURN_STATUSES = ["REQUESTED", "CONFIRMED", "COMPLETED", "REJECTED", "CANCELLED"] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
/** Waiting for a decision, or confirmed and in its window. */
export const OPEN_RETURN_STATUSES: readonly ReturnStatus[] = ["REQUESTED", "CONFIRMED"];
export const isOpenReturn = (status: ReturnStatus) => OPEN_RETURN_STATUSES.includes(status);

/** The return window: a customer can lodge a case up to this many hours (2 days) after delivery. */
export const LODGE_WINDOW_HOURS = 48;
/** Once a case is confirmed, the refund is due within this many working days. */
export const REFUND_WORKING_DAYS = 7;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const LAGOS_OFFSET_MS = HOUR_MS; // Lagos is UTC+1 all year

/** The last moment a customer can lodge a case for a delivery. */
export const lodgeDeadline = (deliveredAt: Date): Date => new Date(deliveredAt.getTime() + LODGE_WINDOW_HOURS * HOUR_MS);

/** Can a case still be lodged for a delivery that arrived at `deliveredAt`? At exactly the deadline it still can. */
export const canLodge = (deliveredAt: Date, now: Date): boolean => now.getTime() <= lodgeDeadline(deliveredAt).getTime();

/**
 * When the refund of a case confirmed at `confirmedAt` is due: 7 working days later, at the same time of day. Weekends are not
 * counted (and a case confirmed on a weekend starts on Monday), the same way the vendor payout hold counts. Public holidays are not excluded.
 */
export const refundDeadline = (confirmedAt: Date): Date => addWorkingDays(confirmedAt, REFUND_WORKING_DAYS);

export type WindowState = "NONE" | "OPEN" | "ENDED";

/** Where a case stands against its refund deadline: not started (not confirmed yet), open, or past it without being completed. */
export function windowState(c: { status: ReturnStatus; windowEndsAt?: Date | null }, now: Date): WindowState {
  if (c.status !== "CONFIRMED" || !c.windowEndsAt) return "NONE";
  return now.getTime() > c.windowEndsAt.getTime() ? "ENDED" : "OPEN";
}

/**
 * Working days left until the deadline: the Monday-to-Friday days (Lagos calendar) after today, up to and including the day it
 * falls on. Right after confirming that is 7. On the deadline day itself it is 0 (the case is still open until the time of day
 * it was confirmed), and it is 0 once the deadline has passed.
 */
export function workingDaysLeft(deadline: Date, now: Date): number {
  if (now.getTime() > deadline.getTime()) return 0;
  const startOfLagosDay = (d: Date) => {
    const t = d.getTime() + LAGOS_OFFSET_MS;
    return t - (((t % DAY_MS) + DAY_MS) % DAY_MS);
  };
  const last = startOfLagosDay(deadline);
  let count = 0;
  for (let day = startOfLagosDay(now) + DAY_MS; day <= last; day += DAY_MS) {
    const weekday = new Date(day).getUTCDay(); // the Lagos clock read as UTC
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}

/**
 * The vendor earnings that go with part of a line: the line's earnings share for `returnedQty` of its `lineQty` units, in whole
 * kobo, rounded half up. Returning every unit takes exactly the whole line's earnings, so nothing is left over.
 */
export function returnedEarningKobo(lineEarningKobo: number, lineQty: number, returnedQty: number): number {
  if (!Number.isInteger(lineEarningKobo) || lineEarningKobo < 0) throw new RangeError("earnings must be a whole number of kobo");
  if (!Number.isInteger(lineQty) || lineQty < 1) throw new RangeError("line quantity must be a whole number of at least 1");
  if (!Number.isInteger(returnedQty) || returnedQty < 1 || returnedQty > lineQty) throw new RangeError("returned quantity must be from 1 to the line quantity");
  return divRoundHalfUp(lineEarningKobo * returnedQty, lineQty);
}

/** The most that can be refunded for a case: the goods returned, plus the delivery fee when the whole delivery is being refunded. */
export const maxRefundKobo = (goodsKobo: number, deliveryFeeKobo: number, wholeDelivery: boolean): number => goodsKobo + (wholeDelivery ? deliveryFeeKobo : 0);

/** A delivery's earnings after refunds took their share off. Never below zero. */
export const netEarningKobo = (vendorEarningKobo: number, returnedKobo: number | null | undefined): number => Math.max(0, vendorEarningKobo - (returnedKobo ?? 0));
