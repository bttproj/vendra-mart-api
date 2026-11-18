import { Router } from "express";
import type { Types } from "mongoose";
import { z } from "zod";
import { requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { created, ok } from "../../utils/respond.js";
import { objectId } from "../../utils/zodCommon.js";
import { Review, publicReview, type ReviewDoc } from "../../models/Review.js";
import { createReview, removeReview, updateReview } from "./reviews.service.js";

// Customers only. A customer reviews a product once it has been delivered to them, and can change or delete their own review.
export const reviewsRouter = Router();
reviewsRouter.use(requireRole("CUSTOMER"));

const rating = z.number().int("Pick a whole number of stars").min(1, "Pick from 1 to 5 stars").max(5, "Pick from 1 to 5 stars");
const comment = z.string().trim().max(1000, "Keep your review to 1000 characters");

const createBody = z.object({ productId: objectId, rating, comment: comment.default("") }).strict();
const updateBody = z
  .object({ rating: rating.optional(), comment: comment.optional() })
  .strict()
  .refine((b) => b.rating !== undefined || b.comment !== undefined, "Change the stars or the words");

/** What a customer gets back about their own review. */
const mine = (r: ReviewDoc) => ({ ...publicReview(r), productId: String(r.productId), status: r.status ?? "APPROVED" });

async function ownReview(customerId: Types.ObjectId, id: string): Promise<ReviewDoc> {
  // Scoped to the signed-in customer: someone else's review looks exactly like one that does not exist.
  const review = await Review.findOne({ _id: id, customerId });
  if (!review) throw AppError.notFound("Review not found");
  return review;
}

reviewsRouter.post(
  "/",
  validate({ body: createBody }),
  asyncHandler(async (req, res) => created(res, mine(await createReview(req.user!, req.validated.body)))),
);

reviewsRouter.patch(
  "/:id",
  validate({ params: z.object({ id: objectId }), body: updateBody }),
  asyncHandler(async (req, res) => {
    const review = await ownReview(req.user!._id, req.validated.params.id);
    ok(res, mine(await updateReview(review, req.validated.body)));
  }),
);

reviewsRouter.delete(
  "/:id",
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    await removeReview(await ownReview(req.user!._id, req.validated.params.id));
    ok(res, { deleted: true });
  }),
);
