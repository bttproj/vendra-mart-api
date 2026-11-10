import { assertKobo, divRoundHalfUp, type Kobo } from "./money.js";

export interface FeeInput {
  /** Road distance from the vendor's pickup point to the customer's address, in metres. */
  distanceMeters: number;
  /** Admin-set price for each km, in kobo. */
  pricePerKmKobo: Kobo;
  /** Optional admin-set floor for one delivery, in kobo. Null or undefined means no minimum. */
  minFeeKobo?: Kobo | null;
}

export interface FeeResult {
  /** Distance rounded to the nearest 0.1 km, expressed in tenths of a km (3.2 km = 32). */
  distanceTenthsKm: number;
  /** The same distance in metres, snapped to the 0.1 km grid used for the fee (3.2 km = 3200). */
  billedMeters: number;
  pricePerKmKobo: Kobo;
  minFeeKobo: Kobo | null;
  minFeeApplied: boolean;
  feeKobo: Kobo;
}

export interface DeliveryRates {
  pricePerKmKobo: Kobo;
  minDeliveryFeeKobo: Kobo | null;
}

/**
 * The rates that apply in one city: the city's own price per km and minimum where the admin set them, the platform's
 * where it did not. Each value falls back on its own, so a city can have its own price per km but share the minimum.
 */
export function ratesForCity(platform: DeliveryRates, city?: { pricePerKmKobo?: Kobo | null; minDeliveryFeeKobo?: Kobo | null } | null): DeliveryRates {
  return {
    pricePerKmKobo: city?.pricePerKmKobo ?? platform.pricePerKmKobo,
    minDeliveryFeeKobo: city?.minDeliveryFeeKobo ?? platform.minDeliveryFeeKobo,
  };
}

/** Nearest 0.1 km, as tenths. 3149 m = 31 (3.1 km), 3150 m = 32 (3.2 km). */
export function metersToTenthsKm(distanceMeters: number): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new RangeError(`distance must be a non-negative number of metres, got ${distanceMeters}`);
  }
  return divRoundHalfUp(Math.round(distanceMeters), 100);
}

/**
 * Delivery fee = road distance (km) x price per km, with an optional minimum.
 *
 * The distance is rounded to 0.1 km FIRST and the fee is computed from that rounded figure, so the
 * checkout line "3.2 km x N200 per km = N640" is always arithmetically true. All maths is integer.
 */
export function calculateDeliveryFee({ distanceMeters, pricePerKmKobo, minFeeKobo }: FeeInput): FeeResult {
  assertKobo(pricePerKmKobo, "price per km");
  const min = minFeeKobo == null ? null : assertKobo(minFeeKobo, "minimum delivery fee");

  const distanceTenthsKm = metersToTenthsKm(distanceMeters);
  // tenths of a km x kobo per km / 10, rounded half up to a whole kobo.
  const raw = divRoundHalfUp(distanceTenthsKm * pricePerKmKobo, 10);
  const feeKobo = min !== null && raw < min ? min : raw;

  return {
    distanceTenthsKm,
    billedMeters: distanceTenthsKm * 100,
    pricePerKmKobo,
    minFeeKobo: min,
    minFeeApplied: min !== null && raw < min,
    feeKobo,
  };
}

/** "3.2" for display. Takes tenths of a km. */
export const formatTenthsKm = (tenths: number) => (tenths / 10).toFixed(1);
