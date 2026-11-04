import { City } from "../models/City.js";
import { Category } from "../models/Category.js";
import { getPricing } from "../models/Settings.js";

// Launch cities: only Ibadan is live. The others are listed as "Coming soon" until the admin switches them on.
const CITIES = [
  { name: "Ibadan", slug: "ibadan", isActive: true, center: { lat: 7.3775, lng: 3.947 }, radiusKm: 30, sortOrder: 1 },
  { name: "Lagos", slug: "lagos", isActive: false, center: { lat: 6.5244, lng: 3.3792 }, radiusKm: 40, sortOrder: 2 },
  { name: "Port Harcourt", slug: "port-harcourt", isActive: false, center: { lat: 4.8156, lng: 7.0498 }, radiusKm: 25, sortOrder: 3 },
  { name: "Benin", slug: "benin", isActive: false, center: { lat: 6.335, lng: 5.6037 }, radiusKm: 20, sortOrder: 4 },
  { name: "Abuja", slug: "abuja", isActive: false, center: { lat: 9.0765, lng: 7.3986 }, radiusKm: 30, sortOrder: 5 },
];

// Categories from the storefront screen.
export const CATEGORIES = [
  "Grains & flour",
  "Oils & condiments",
  "Tubers & produce",
  "Beans & legumes",
  "Fashion",
  "Beauty & fragrance",
  "Accessories",
];

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The slugs of the starter categories. The seed adds them back if they are missing, so they cannot be deleted. */
export const STARTER_CATEGORY_SLUGS: string[] = CATEGORIES.map((n) => slugify(n));

/**
 * Idempotent. Inserts missing cities/categories only, and never overwrites an existing city's
 * isActive flag, so re-running the seed cannot switch off a city the admin turned on.
 */
export async function seedReferenceData() {
  for (const c of CITIES) {
    await City.updateOne({ slug: c.slug }, { $setOnInsert: c }, { upsert: true });
  }
  await getPricing(); // N200 per km, no minimum, 10% commission; the admin changes these later
  for (const [i, name] of CATEGORIES.entries()) {
    await Category.updateOne({ slug: slugify(name) }, { $setOnInsert: { name, slug: slugify(name), sortOrder: i + 1 } }, { upsert: true });
  }
}
