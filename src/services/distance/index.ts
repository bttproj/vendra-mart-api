import { env, isProd } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import type { DistanceProvider } from "./DistanceProvider.js";
import { CachedDistanceProvider } from "./CachedDistanceProvider.js";
import { DevStraightLineProvider } from "./DevStraightLineProvider.js";
import { GoogleRoutesProvider, type DistanceCheck } from "./GoogleRoutesProvider.js";

let override: DistanceProvider | undefined;
let cached: DistanceProvider | undefined;

/** Tests swap in a fake with fixed distances. */
export function setDistanceProvider(provider: DistanceProvider | undefined) {
  override = provider;
}

export function getDistanceProvider(): DistanceProvider {
  if (override) return override;
  if (cached) return cached;

  if (env.GOOGLE_MAPS_SERVER_KEY) {
    cached = new CachedDistanceProvider(new GoogleRoutesProvider(env.GOOGLE_MAPS_SERVER_KEY));
  } else if (!isProd) {
    cached = new DevStraightLineProvider(); // not cached, so adding a real key later recomputes
  } else {
    // Fail loudly rather than quietly charging customers from a guess.
    cached = {
      async driveDistanceMeters() {
        throw AppError.unavailable("Delivery pricing is not configured");
      },
    };
  }
  return cached;
}

/** Tries the real distance service once and says in plain words whether it works. For the admin; never shown to shoppers. */
export async function checkDistanceService(): Promise<DistanceCheck> {
  if (override) return { ok: true, provider: "test", meters: 0 };
  if (env.GOOGLE_MAPS_SERVER_KEY) return new GoogleRoutesProvider(env.GOOGLE_MAPS_SERVER_KEY).check();
  if (!isProd) return { ok: true, provider: "estimate" };
  return {
    ok: false,
    provider: "none",
    problem: "No Google key is set for delivery distances.",
    hint: "Set GOOGLE_MAPS_SERVER_KEY in the environment of the API (a key with the Routes API enabled) and restart the API.",
  };
}

export type { DistanceCheck } from "./GoogleRoutesProvider.js";
export type { DistanceProvider } from "./DistanceProvider.js";
