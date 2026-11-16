// What the admin's product stock view says about a product. Pure functions (no I/O), unit tested.
//
// Three numbers per product: how many units the vendor has put up in all ("uploaded"), how many are left to buy, and how many
// have been sold. Stock is taken when an order is placed (and given back if it is never paid), and `soldCount` rises when the
// payment is confirmed, so while an order waits for payment its units are in neither "left" nor "sold".

/** A product with this many units or fewer left (but not none) counts as running low, unless the admin picks another number. */
export const DEFAULT_LOW_STOCK = 5;

export type StockLevel = "out" | "low" | "ok";

export function stockLevel(stock: number, lowAt: number = DEFAULT_LOW_STOCK): StockLevel {
  if (stock <= 0) return "out";
  return stock <= lowAt ? "low" : "ok";
}

interface Counted {
  stock: number;
  soldCount: number;
  /** Missing on products made before uploads were counted. */
  uploadedCount?: number | null;
}

/** Units uploaded in all. A product from before uploads were counted is taken to have been uploaded as what is left plus what sold. */
export const uploadedUnits = (p: Counted): number => p.uploadedCount ?? p.stock + p.soldCount;

/**
 * The uploaded count after a vendor sets the stock to `newStock`. Putting more on the shelf adds to it, and taking a correction
 * off (a miscount, damaged goods) takes from it, so uploaded always equals what is left plus what has sold.
 */
export function uploadedAfterEdit(p: Counted, newStock: number): number {
  return Math.max(0, uploadedUnits(p) + (newStock - p.stock));
}
