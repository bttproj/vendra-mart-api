import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";
import { ratingSummary } from "../../domain/rating.js";
import { Product } from "../../models/Product.js";
import { APPROVED_FILTER, Review, publicReview } from "../../models/Review.js";
import { publicVendor, Vendor } from "../../models/Vendor.js";
import { ratingBreakdown, vendorRating } from "../reviews/reviews.service.js";
import { catalogQuery } from "./product.schemas.js";
import { cityNames, homeData, productDetail, searchProducts, visibleVendors } from "./catalog.service.js";

// Public, no login. Everything here goes through visibleVendors(), so unapproved stores never leak.
export const catalogRouter = Router();

catalogRouter.get(
  "/home",
  validate({ query: z.object({ city: z.string().trim().max(60).optional() }) }),
  asyncHandler(async (req, res) => ok(res, await homeData(req.validated.query.city))),
);

catalogRouter.get(
  "/products",
  validate({ query: catalogQuery }),
  asyncHandler(async (req, res) => {
    const q = req.validated.query;
    const { items, total } = await searchProducts(q);
    ok(res, items, { page: q.page, limit: q.limit, total });
  }),
);

catalogRouter.get(
  "/products/:slug",
  validate({ params: z.object({ slug: z.string().trim().min(1).max(200) }) }),
  asyncHandler(async (req, res) => {
    const detail = await productDetail(req.validated.params.slug);
    if (!detail) throw AppError.notFound("Product not found");
    ok(res, detail);
  }),
);

catalogRouter.get(
  "/vendors",
  validate({ query: z.object({ q: z.string().trim().max(100).optional(), city: z.string().trim().max(60).optional() }) }),
  asyncHandler(async (req, res) => {
    const { q, city } = req.validated.query;
    const vendors = await visibleVendors({ city, nameQuery: q });
    const cities = await cityNames(vendors);
    ok(res, vendors.map((v) => publicVendor(v, cities.get(String(v._id)))));
  }),
);

catalogRouter.get(
  "/vendors/:slug",
  validate({ params: z.object({ slug: z.string().trim().min(1).max(200) }) }),
  asyncHandler(async (req, res) => {
    const [vendor] = await visibleVendors({ vendorSlug: req.validated.params.slug });
    if (!vendor) throw AppError.notFound("Store not found");
    ok(res, { ...publicVendor(vendor, (await cityNames([vendor])).get(String(vendor._id))), rating: await vendorRating(vendor._id) });
  }),
);

// What customers who received a product said about it: the average, how many gave each number of stars, and the reviews
// newest first. Public, with only a short name for each author.
catalogRouter.get(
  "/products/:slug/reviews",
  validate({
    params: z.object({ slug: z.string().trim().min(1).max(200) }),
    query: z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(30).default(10) }),
  }),
  asyncHandler(async (req, res) => {
    const product = await Product.findOne({ slug: req.validated.params.slug.toLowerCase(), isActive: true });
    if (!product || !(await Vendor.exists({ _id: product.vendorId, status: "APPROVED" }))) throw AppError.notFound("Product not found");
    const { page, limit } = req.validated.query as { page: number; limit: number };
    const [items, total, breakdown] = await Promise.all([
      Review.find({ productId: product._id, ...APPROVED_FILTER })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Review.countDocuments({ productId: product._id, ...APPROVED_FILTER }),
      ratingBreakdown(product._id),
    ]);
    ok(res, { summary: { ...ratingSummary(product.ratingSum, product.ratingCount), breakdown }, reviews: items.map(publicReview) }, { page, limit, total });
  }),
);
