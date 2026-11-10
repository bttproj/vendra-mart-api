import { Router } from "express";
import { z } from "zod";
import { calculateDeliveryFee, ratesForCity } from "../../domain/deliveryFee.js";
import { percentOf } from "../../domain/money.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";
import { kobo, objectId } from "../../utils/zodCommon.js";
import { City, publicCity } from "../../models/City.js";
import { Settings, getPricing, getRequireNin } from "../../models/Settings.js";
import { Vendor } from "../../models/Vendor.js";

// Mounted under /api/admin, behind requireRole("ADMIN").
export const adminSettingsRouter = Router();

// Public: the vendor sign-up and settings screens ask whether a NIN is required. Nothing private is in the answer.
export const vendorRulesRouter = Router();
vendorRulesRouter.get(
  "/vendor-rules",
  asyncHandler(async (_req, res) => ok(res, { requireNin: await getRequireNin() })),
);

/** Hard ceilings that catch a typo (an extra zero) before it reaches customers. */
const MAX_PRICE_PER_KM_KOBO = 1_000_000; // N10,000 per km
const MAX_MIN_FEE_KOBO = 10_000_000; // N100,000

const pricingBody = z
  .object({
    pricePerKmKobo: kobo.max(MAX_PRICE_PER_KM_KOBO, "That price per km looks too high"),
    // null means "no minimum".
    minDeliveryFeeKobo: kobo.max(MAX_MIN_FEE_KOBO, "That minimum looks too high").nullable(),
    commissionBps: z.number().int("Commission must be a whole number of basis points").min(0).max(10000),
  })
  .strict();

async function present() {
  const [pricing, doc, cities, requireNin] = await Promise.all([getPricing(), Settings.findOne({ key: "singleton" }), City.find().sort({ sortOrder: 1, name: 1 }), getRequireNin()]);
  const counts = await Vendor.aggregate<{ _id: unknown; n: number }>([{ $match: { status: "APPROVED" } }, { $group: { _id: "$pickup.cityId", n: { $sum: 1 } } }]);
  const byCity = new Map(counts.map((c) => [String(c._id), c.n]));
  return {
    pricing,
    vendorRules: { requireNin },
    updatedAt: doc?.updatedAt ?? null,
    cities: cities.map((c) => ({
      ...publicCity(c),
      vendorCount: byCity.get(String(c._id)) ?? 0,
      // The city's own fares (null = the platform price above) and what customers there are actually charged.
      pricePerKmKobo: c.pricePerKmKobo ?? null,
      minDeliveryFeeKobo: c.minDeliveryFeeKobo ?? null,
      effective: ratesForCity(pricing, c),
    })),
  };
}

adminSettingsRouter.get("/settings", asyncHandler(async (_req, res) => ok(res, await present())));

adminSettingsRouter.put(
  "/settings",
  validate({ body: pricingBody }),
  asyncHandler(async (req, res) => {
    await getPricing(); // make sure the document exists
    await Settings.updateOne({ key: "singleton" }, { $set: { ...req.validated.body, updatedBy: req.user!._id } });
    ok(res, await present());
  }),
);

adminSettingsRouter.put(
  "/settings/vendor-rules",
  validate({ body: z.object({ requireNin: z.boolean() }).strict() }),
  asyncHandler(async (req, res) => {
    await getPricing(); // make sure the document exists
    await Settings.updateOne({ key: "singleton" }, { $set: { requireNin: req.validated.body.requireNin, updatedBy: req.user!._id } });
    ok(res, await present());
  }),
);

/**
 * Works out, with the same pure functions orders use, what a delivery and a sale would come to under the values
 * being typed. Saves nothing. The browser never does this arithmetic itself.
 */
adminSettingsRouter.post(
  "/settings/preview",
  validate({
    body: pricingBody.extend({ distanceMeters: z.number().min(0).max(500_000), saleKobo: kobo.max(1_000_000_000) }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;
    const fee = calculateDeliveryFee({ distanceMeters: b.distanceMeters, pricePerKmKobo: b.pricePerKmKobo, minFeeKobo: b.minDeliveryFeeKobo });
    const commissionKobo = percentOf(b.saleKobo, b.commissionBps);
    ok(res, {
      distanceTenthsKm: fee.distanceTenthsKm,
      deliveryFeeKobo: fee.feeKobo,
      minFeeApplied: fee.minFeeApplied,
      saleKobo: b.saleKobo,
      commissionKobo,
      vendorEarningKobo: b.saleKobo - commissionKobo,
    });
  }),
);

// A city's own delivery fares. null clears one so the city goes back to the platform price. A minimum of 0 means no minimum in that city.
adminSettingsRouter.put(
  "/cities/:id/pricing",
  validate({
    params: z.object({ id: objectId }),
    body: z
      .object({
        pricePerKmKobo: kobo.max(MAX_PRICE_PER_KM_KOBO, "That price per km looks too high").nullable(),
        minDeliveryFeeKobo: kobo.max(MAX_MIN_FEE_KOBO, "That minimum looks too high").nullable(),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const city = await City.findById(req.validated.params.id);
    if (!city) throw AppError.notFound("City not found");
    city.pricePerKmKobo = req.validated.body.pricePerKmKobo;
    city.minDeliveryFeeKobo = req.validated.body.minDeliveryFeeKobo;
    await city.save();
    ok(res, await present());
  }),
);

adminSettingsRouter.patch(
  "/cities/:id",
  validate({ params: z.object({ id: objectId }), body: z.object({ isActive: z.boolean() }).strict() }),
  asyncHandler(async (req, res) => {
    const city = await City.findById(req.validated.params.id);
    if (!city) throw AppError.notFound("City not found");
    city.isActive = req.validated.body.isActive;
    await city.save();
    ok(res, publicCity(city));
  }),
);
