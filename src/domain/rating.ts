// Star ratings from customers. Pure functions (no I/O), unit tested.

export const MIN_RATING = 1;
export const MAX_RATING = 5;

/** A whole number of stars from 1 to 5. */
export const isRating = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= MIN_RATING && n <= MAX_RATING;

/**
 * The average in tenths of a star (43 means 4.3), rounded half up, from the sum of all the stars given and how many ratings
 * there are. Whole-number maths all the way, so 4.35 can never come out as 4.3 because of a float. Zero when there are none.
 */
export function averageTenths(sum: number, count: number): number {
  if (!Number.isInteger(sum) || !Number.isInteger(count) || sum < 0 || count < 0) throw new RangeError("sum and count must be whole numbers of at least 0");
  if (count === 0) return 0;
  return Math.floor((20 * sum + count) / (2 * count));
}

/** What the shop shows beside a product or a store: the average (to one decimal) and how many ratings it comes from. */
export function ratingSummary(sum: number | null | undefined, count: number | null | undefined): { average: number; count: number } {
  const s = sum ?? 0;
  const c = count ?? 0;
  return { average: averageTenths(s, c) / 10, count: c };
}

/** "Ada Okafor" becomes "Ada O.": enough for readers to trust a review, without publishing a customer's full name. */
export function reviewerName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Customer";
  const first = parts[0]!;
  const last = parts.length > 1 ? parts[parts.length - 1]! : "";
  return last ? `${first} ${last.slice(0, 1).toUpperCase()}.` : first;
}
