import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";
import { escapeRegex, objectId, pagination } from "../../utils/zodCommon.js";
import { APPROVED_FILTER, Review } from "../../models/Review.js";
import { User } from "../../models/User.js";
import { Vendor } from "../../models/Vendor.js";
import { approveReview, removeReview } from "../reviews/reviews.service.js";

// Mounted under /api/admin/reviews, behind requireRole("ADMIN") and the catalogue or vendors area.
// Customers write reviews in public, so the admin can take one down (abuse, a wrong product, a personal detail).
export const adminReviewsRouter = Router();

adminReviewsRouter.get(
  "/",
  validate({
    query: pagination.extend({
      q: z.string().trim().max(100).optional(), // the product, the reviewer or the words
      rating: z.coerce.number().int().min(1).max(5).optional(),
      vendorId: objectId.optional(),
      // PENDING: waiting for approval. APPROVED: public.
      status: z.enum(["PENDING", "APPROVED"]).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, rating, vendorId, status } = req.validated.query as { page: number; limit: number; q?: string; rating?: number; vendorId?: string; status?: "PENDING" | "APPROVED" };
    const filter: Record<string, unknown> = {};
    if (rating) filter.rating = rating;
    if (vendorId) filter.vendorId = vendorId;
    if (status === "PENDING") filter.status = "PENDING";
    if (status === "APPROVED") Object.assign(filter, APPROVED_FILTER);
    if (q) {
      const re = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ productName: re }, { authorName: re }, { comment: re }];
    }

    const [items, total] = await Promise.all([
      Review.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Review.countDocuments(filter),
    ]);
    const [vendors, customers] = await Promise.all([
      Vendor.find({ _id: { $in: items.map((r) => r.vendorId) } }).select("businessName"),
      User.find({ _id: { $in: items.map((r) => r.customerId) } }).select("name email"),
    ]);
    const vendorName = new Map(vendors.map((v) => [String(v._id), v.businessName]));
    const customerById = new Map(customers.map((c) => [String(c._id), c]));

    ok(
      res,
      items.map((r) => ({
        id: String(r._id),
        rating: r.rating,
        status: r.status ?? "APPROVED",
        comment: r.comment ?? "",
        productName: r.productName,
        productId: String(r.productId),
        vendor: { id: String(r.vendorId), businessName: vendorName.get(String(r.vendorId)) ?? "Store" },
        // What shoppers see, and who it really is, so an admin can follow up on an abusive review.
        authorName: r.authorName,
        customer: { name: customerById.get(String(r.customerId))?.name ?? r.authorName, email: customerById.get(String(r.customerId))?.email ?? null },
        createdAt: r.createdAt,
      })),
      { page, limit, total },
    );
  }),
);

// How many are waiting and how many are public, for the tabs and the number beside "Reviews" in the menu.
adminReviewsRouter.get(
  "/counts",
  asyncHandler(async (_req, res) => {
    const [pending, approved] = await Promise.all([Review.countDocuments({ status: "PENDING" }), Review.countDocuments(APPROVED_FILTER)]);
    ok(res, { pending, approved });
  }),
);

adminReviewsRouter.post(
  "/:id/approve",
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const review = await Review.findById(req.validated.params.id);
    if (!review) throw AppError.notFound("Review not found");
    const approved = await approveReview(review, req.user!);
    ok(res, { id: String(approved._id), status: approved.status ?? "APPROVED" });
  }),
);

adminReviewsRouter.delete(
  "/:id",
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const review = await Review.findById(req.validated.params.id);
    if (!review) throw AppError.notFound("Review not found");
    await removeReview(review);
    ok(res, { deleted: true });
  }),
);
