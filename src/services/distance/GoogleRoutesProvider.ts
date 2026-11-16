import type { LatLng } from "../../domain/geo.js";
import { AppError } from "../../utils/AppError.js";
import type { DistanceProvider } from "./DistanceProvider.js";

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const SHOPPER_MESSAGE = "We could not work out the delivery distance right now. Please try again in a moment.";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** What one call to Google came to. Kept apart from the shopper's message so the operator can be told the real reason. */
export type RouteOutcome =
  | { kind: "ok"; meters: number }
  | { kind: "no-route" }
  | { kind: "http"; status: number; detail: string }
  | { kind: "network"; reason: string };

export interface DistanceCheck {
  ok: boolean;
  /** "google", or "estimate" when no key is set outside production. */
  provider: string;
  /** Plain words for the admin: what is wrong. Empty when ok. */
  problem?: string;
  /** Plain words for the admin: what to do about it. */
  hint?: string;
  /** The sample route Google measured, when ok. */
  meters?: number;
}

/**
 * Turns a failed call into words the person running the site can act on. Admin only: it can quote Google's own message,
 * so the key is blanked out of it, and nothing here ever reaches a shopper.
 */
export function explainFailure(outcome: Exclude<RouteOutcome, { kind: "ok" } | { kind: "no-route" }>, apiKey = ""): { problem: string; hint: string } {
  const clean = (text: string) => (apiKey ? text.split(apiKey).join("[key]") : text).replace(/\s+/g, " ").trim().slice(0, 240);

  if (outcome.kind === "network") {
    const reason = clean(outcome.reason);
    if (/abort|timed? ?out|ETIMEDOUT/i.test(reason)) {
      return { problem: "Google did not answer in time.", hint: "Either Google was slow or this server cannot make outgoing connections. Try again, and if it keeps happening ask your host whether outgoing HTTPS requests are allowed." };
    }
    if (/fetch is not|not a function|not defined/i.test(reason)) {
      return { problem: "This server's Node.js is too old to call Google.", hint: "The API needs Node.js 18 or newer. Change the Node.js version for the API in your hosting panel and restart it." };
    }
    return { problem: `The server could not reach Google (${reason || "no reason given"}).`, hint: "Ask your host whether outgoing HTTPS requests are allowed, and check the server has an internet connection." };
  }

  const { status } = outcome;
  const detail = clean(outcome.detail);
  const said = detail ? ` Google said: ${detail}` : "";
  if (/referer|referrer/i.test(detail)) {
    return { problem: "The Google key is restricted to websites, so the API cannot use it.", hint: `Use a separate key for the API (GOOGLE_MAPS_SERVER_KEY) with Application restrictions set to None, or to the server's IP address. Keep the website-restricted key for the browser only.${said}` };
  }
  if (/\bIP address\b|ip.*not allowed/i.test(detail)) {
    return { problem: "The Google key only allows certain IP addresses and this server's is not one of them.", hint: `In Google Cloud, Credentials, open the server key and add this server's IP address, or set Application restrictions to None.${said}` };
  }
  if (/SERVICE_DISABLED|has not been used|is disabled|not enabled/i.test(detail)) {
    return { problem: "The Routes API is not switched on for this Google project.", hint: `In Google Cloud, APIs and services, enable "Routes API" (not only Maps JavaScript or Distance Matrix), then try again in a few minutes.${said}` };
  }
  if (/billing/i.test(detail)) {
    return { problem: "Google billing is not set up for this project.", hint: `Link a billing account to the Google Cloud project. Google requires it even for the free allowance.${said}` };
  }
  if (status === 400 && /api key|API_KEY_INVALID/i.test(detail)) {
    return { problem: "Google does not accept the key.", hint: `Check GOOGLE_MAPS_SERVER_KEY on the server for a typo, a missing character or extra spaces, and restart the API.${said}` };
  }
  if (status === 401 || status === 403) {
    return { problem: "Google refused the request.", hint: `Check the key's API restrictions allow "Routes API", and that billing is on.${said}` };
  }
  if (status === 429) {
    return { problem: "Google says the quota is used up.", hint: `Raise the Routes API quota in Google Cloud, or wait and try again.${said}` };
  }
  return { problem: `Google answered with an error (${status}).`, hint: `Try again in a moment.${said}` };
}

/**
 * Road distance from the Google Routes API (the successor to the legacy Distance Matrix API).
 * Called from the server only, with a server-side key that never reaches the browser.
 */
export class GoogleRoutesProvider implements DistanceProvider {
  constructor(
    private apiKey: string,
    private fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private timeoutMs = 8000,
  ) {}

  /** One call to Google, with no judgement about what it means. */
  private async call(origin: LatLng, destination: LatLng): Promise<RouteOutcome> {
    const point = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          // Ask only for the distance; a smaller field mask is cheaper and faster.
          "X-Goog-FieldMask": "routes.distanceMeters",
        },
        body: JSON.stringify({
          origin: point(origin),
          destination: point(destination),
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_UNAWARE",
          units: "METRIC",
        }),
      });

      if (!res.ok) return { kind: "http", status: res.status, detail: await res.text().catch(() => "") };

      const json = (await res.json().catch(() => null)) as { routes?: { distanceMeters?: number }[] } | null;
      const meters = json?.routes?.[0]?.distanceMeters;
      // Google answered but found no drivable route (for example a pin on water).
      if (typeof meters !== "number" || !Number.isFinite(meters) || meters < 0) return { kind: "no-route" };
      return { kind: "ok", meters };
    } catch (err) {
      return { kind: "network", reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async driveDistanceMeters(origin: LatLng, destination: LatLng): Promise<number> {
    let outcome = await this.call(origin, destination);
    // A dropped connection or a Google hiccup is worth one more try; a refusal (bad key, API off) is not.
    if (outcome.kind === "network" || (outcome.kind === "http" && outcome.status >= 500)) outcome = await this.call(origin, destination);

    if (outcome.kind === "ok") return outcome.meters;
    if (outcome.kind === "no-route") throw AppError.validation("We could not find a driving route to that address. Move the pin to a nearby road and try again.");

    // The reason goes to the operator's log; never to the shopper (it can name the key or quota).
    const { problem, hint } = explainFailure(outcome, this.apiKey);
    console.error(`Delivery distance failed: ${problem} ${hint}`);
    throw AppError.unavailable(SHOPPER_MESSAGE);
  }

  /** A real call on a short fixed route, explained in plain words. Lets the admin test the key without placing an order. */
  async check(): Promise<DistanceCheck> {
    const outcome = await this.call({ lat: 7.3775, lng: 3.947 }, { lat: 7.4, lng: 3.9 });
    if (outcome.kind === "ok") return { ok: true, provider: "google", meters: outcome.meters };
    if (outcome.kind === "no-route") return { ok: false, provider: "google", problem: "Google answered but found no route for the test trip.", hint: "The key works, but try again in a moment." };
    return { ok: false, provider: "google", ...explainFailure(outcome, this.apiKey) };
  }
}
