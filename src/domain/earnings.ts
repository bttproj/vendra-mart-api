import type { OrderStatus } from "./orderStateMachine.js";

// The hold on vendor earnings and the earning states built on it. Earnings unlock 4 working days after delivery.
// Everything is derived from timestamps and the payout link, so nothing depends on a scheduled job having run: a
// vendor's money becomes "available" the instant the hold ends, whether or not the order has been marked COMPLETED yet.
//
// Working days are Monday to Friday in Lagos time (UTC+1, no daylight saving). Public holidays are not excluded.
// A delivery on a Saturday or Sunday counts as the start of Monday, so a later delivery never unlocks before an
// earlier one (which is what lets the database ask "what has unlocked by now?" with a single timestamp).

export const HOLD_WORKING_DAYS = 4;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const LAGOS_OFFSET_MS = HOUR_MS;

/** The same instant shifted so that reading it as UTC gives the wall clock in Lagos. */
const toLagosClock = (d: Date) => d.getTime() + LAGOS_OFFSET_MS;
const isWeekend = (lagosClockMs: number) => {
  const day = new Date(lagosClockMs).getUTCDay();
  return day === 0 || day === 6;
};

/**
 * `days` working days after `from`, at the same time of day, counting Monday to Friday in Lagos time. A start on a Saturday
 * or Sunday counts as the start of Monday. Also used for the refund deadline of a return.
 */
export function addWorkingDays(from: Date, days: number): Date {
  let t = toLagosClock(from);
  const startOfDay = t - (((t % DAY_MS) + DAY_MS) % DAY_MS);
  const weekday = new Date(t).getUTCDay();
  if (weekday === 6) t = startOfDay + 2 * DAY_MS; // Saturday: counts as Monday 00:00
  else if (weekday === 0) t = startOfDay + DAY_MS; // Sunday: counts as Monday 00:00
  for (let i = 0; i < days; i++) {
    t += DAY_MS;
    while (isWeekend(t)) t += DAY_MS;
  }
  return new Date(t - LAGOS_OFFSET_MS);
}

/** The exact moment earnings unlock: deliveredAt plus 4 working days, at the same time of day. */
export const holdEndsAt = (deliveredAt: Date): Date => addWorkingDays(deliveredAt, HOLD_WORKING_DAYS);

/** True once the hold has fully passed. At exactly the unlock moment it is true. */
export const holdHasEnded = (deliveredAt: Date, now: Date): boolean => now.getTime() >= holdEndsAt(deliveredAt).getTime();

/**
 * The latest `deliveredAt` that has already cleared the hold at `now`: a delivery at or before this is unlocked.
 * holdEndsAt only ever moves forward as the delivery time does, so this is found by halving a search range (a hold
 * is never longer than a week), to the exact millisecond.
 */
export function unlockedBefore(now: Date): Date {
  let lo = now.getTime() - 8 * DAY_MS; // certainly unlocked
  let hi = now.getTime(); // certainly not: the hold always ends after the delivery
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (holdEndsAt(new Date(mid)).getTime() <= now.getTime()) lo = mid;
    else hi = mid;
  }
  return new Date(lo);
}

export const EARNING_STATES = ["NONE", "AWAITING_DELIVERY", "ON_HOLD", "AVAILABLE", "REQUESTED", "PAID"] as const;
/**
 * NONE               nothing is owed (unpaid or cancelled order)
 * AWAITING_DELIVERY  paid by the customer but not delivered yet (includes a failed delivery that may be retried)
 * ON_HOLD            delivered, inside the 4 working day hold
 * AVAILABLE          delivered, hold over, not part of a payout: can be requested
 * REQUESTED          locked in a payout the admin has not decided yet
 * PAID               included in a payout the admin has paid
 */
export type EarningState = (typeof EARNING_STATES)[number];

/** Payout status as far as earnings are concerned. A DECLINED payout releases its orders, so it counts as no payout. */
export type PayoutLink = "REQUESTED" | "PAID" | "DECLINED" | null | undefined;

export interface EarningInput {
  status: OrderStatus;
  deliveredAt?: Date | null;
  payoutStatus?: PayoutLink;
  /** A return or problem report is open on this delivery. */
  returnHold?: boolean;
}

export interface EarningResult {
  state: EarningState;
  /** Only for ON_HOLD. */
  unlocksAt?: Date;
  /** ON_HOLD because a return is open, not because of the 4 working days: there is no unlock date until it is settled. */
  heldForReturn?: boolean;
}

const DELIVERED_STATES: OrderStatus[] = ["DELIVERED", "COMPLETED"];
const NOT_YET_DELIVERED: OrderStatus[] = ["PAID", "READY_FOR_PICKUP", "PICKED_UP", "FAILED_DELIVERY"];

/** Where one sub-order's earnings stand right now. Pure: same inputs, same answer. */
export function earningState({ status, deliveredAt, payoutStatus, returnHold }: EarningInput, now: Date): EarningResult {
  if (NOT_YET_DELIVERED.includes(status)) return { state: "AWAITING_DELIVERY" };
  if (!DELIVERED_STATES.includes(status)) return { state: "NONE" }; // PENDING_PAYMENT, CANCELLED

  // Delivered. A payout that is still open or already paid owns the money.
  if (payoutStatus === "PAID") return { state: "PAID" };
  if (payoutStatus === "REQUESTED") return { state: "REQUESTED" };

  // An open return keeps the money on hold, however many days have passed, until the case is settled.
  if (returnHold) return { state: "ON_HOLD", heldForReturn: true };

  // No delivery time on a delivered order would be a data fault; treat it as still on hold rather than pay out early.
  if (!deliveredAt) return { state: "ON_HOLD" };
  if (holdHasEnded(deliveredAt, now)) return { state: "AVAILABLE" };

  return { state: "ON_HOLD", unlocksAt: holdEndsAt(deliveredAt) };
}
