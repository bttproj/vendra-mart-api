// Which delivery handler gets the next delivery when the admin has switched on automatic assignment. Pure (no I/O), unit tested.

export interface HandlerLoad {
  id: string;
  /** Deliveries they are carrying now: paid and waiting, ready, out for delivery, or failed and waiting for a retry. */
  open: number;
  /** Every delivery they have ever been given. */
  total: number;
}

/**
 * The handler with the fewest deliveries in hand. When that is a tie, the one who has been given the fewest in all, so a
 * quiet day (everyone at nothing) hands deliveries round the team instead of always to the same person. A last tie goes to
 * the lower id, so the answer never changes between two identical runs. Null when there is no one to give it to.
 */
export function chooseHandler(candidates: HandlerLoad[]): string | null {
  if (candidates.length === 0) return null;
  const best = [...candidates].sort((a, b) => a.open - b.open || a.total - b.total || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]!;
  return best.id;
}
