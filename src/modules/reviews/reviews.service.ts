import { Types } from "mongoose";
import { ratingSummary, reviewerName } from "../../domain/rating.js";
import { Product } from "../../models/Product.js";
import { APPROVED_FILTER, Review, isApprovedStatus, type ReviewDoc } from "../../models/Review.js";
import { SubOrder } from "../../models/SubOrder.js";
import { User, type UserDoc } from "../../models/User.js";
import { Vendor } from "../../models/Vendor.js";
import { getNotifier } from "../../services/notifications/index.js";
import { AppError } from "../../utils/AppError.js";
import { notifyTeam } from "../accounts/team.js";

/** A delivery counts once the parcel has reached the customer. */
export const REVIEWABLE_STATUSES = ["DELIVERED", "COMPLETED"] as const;

/** The delivered sub-order that lets this customer review this product, or null when they have not received it. */
export async function deliveredSubOrder(customerId: Types.ObjectId, productId: Types.ObjectId | string) {
  return SubOrder.findOne({ customerId, status: { $in: [...REVIEWABLE_STATUSES] }, "items.productId": productId }).sort({ deliveredAt: -1 });
}

/**
 * Saves a customer's review of a product they have received. Only after a delivery and once per product. It starts PENDING:
 * it is not public, and not in the product's average, until an admin approves it.
 */
export async function createReview(customer: UserDoc, input: { productId: string; rating: number; comment: string }): Promise<ReviewDoc> {
  const product = await Product.findById(input.productId);
  if (!product) throw AppError.notFound("That product is no longer on VendraMart, so it cannot be reviewed.");

  const sub = await deliveredSubOrder(customer._id, product._id);
  if (!sub) throw AppError.forbidden("You can review a product once it has been delivered to you.");

  let review: ReviewDoc;
  try {
    review = await Review.create({
      customerId: customer._id,
      productId: product._id,
      vendorId: product.vendorId,
      subOrderId: sub._id,
      rating: input.rating,
      comment: input.comment,
      authorName: reviewerName(customer.name),
      productName: product.name,
      status: "PENDING",
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw AppError.conflict("You have already reviewed this product. You can change your review instead.");
    throw err;
  }
  await notifyTeam(["catalog", "vendors"], {
    kind: "REVIEW_PENDING",
    title: "A review is waiting for approval",
    body: `${review.authorName} gave ${product.name} ${review.rating} out of 5. Approve or delete it.`,
    link: "/admin/reviews",
  });
  return review;
}

/**
 * Changes the stars or the words of a review. A review that was already public goes back to waiting for approval, so words
 * cannot be swapped after it was checked, and its stars leave the product's average until it is approved again.
 */
export async function updateReview(review: ReviewDoc, changes: { rating?: number; comment?: string }): Promise<ReviewDoc> {
  const before = review.rating;
  const wasPublic = isApprovedStatus(review.status);
  if (changes.rating !== undefined) review.rating = changes.rating;
  if (changes.comment !== undefined) review.comment = changes.comment;
  if (wasPublic) {
    review.status = "PENDING";
    review.set("approvedAt", undefined);
    review.set("approvedBy", undefined);
  }
  await review.save();
  if (wasPublic) await Product.updateOne({ _id: review.productId, ratingCount: { $gte: 1 } }, { $inc: { ratingCount: -1, ratingSum: -before } });
  return review;
}

/** An admin approves a waiting review: it becomes public and counts towards the product's average. Safe to repeat. */
export async function approveReview(review: ReviewDoc, admin: UserDoc): Promise<ReviewDoc> {
  const approved = await Review.findOneAndUpdate({ _id: review._id, status: "PENDING" }, { status: "APPROVED", approvedAt: new Date(), approvedBy: admin._id }, { returnDocument: "after" });
  if (!approved) return (await Review.findById(review._id)) ?? review; // already approved, or removed meanwhile
  await Product.updateOne({ _id: approved.productId }, { $inc: { ratingCount: 1, ratingSum: approved.rating } });
  await tellVendor(approved, approved.productName);
  return approved;
}

/** Removes a review (by its author or by an admin). A public one also comes out of the product's average. */
export async function removeReview(review: ReviewDoc): Promise<void> {
  const gone = await Review.findOneAndDelete({ _id: review._id });
  if (!gone) return; // someone else removed it first
  if (isApprovedStatus(gone.status)) {
    await Product.updateOne({ _id: gone.productId, ratingCount: { $gte: 1 } }, { $inc: { ratingCount: -1, ratingSum: -gone.rating } });
  }
}

/** The store's average over every approved review of its products, for the store page. */
export async function vendorRating(vendorId: Types.ObjectId | string) {
  const [row] = await Review.aggregate<{ sum: number; count: number }>([
    { $match: { vendorId: new Types.ObjectId(String(vendorId)), ...APPROVED_FILTER } },
    { $group: { _id: null, sum: { $sum: "$rating" }, count: { $sum: 1 } } },
  ]);
  return ratingSummary(row?.sum, row?.count);
}

/** How many approved reviews gave each number of stars, for the bars on a product page. Keys "1" to "5". */
export async function ratingBreakdown(productId: Types.ObjectId) {
  const rows = await Review.aggregate<{ _id: number; n: number }>([{ $match: { productId, ...APPROVED_FILTER } }, { $group: { _id: "$rating", n: { $sum: 1 } } }]);
  const out: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  for (const r of rows) out[String(r._id)] = r.n;
  return out;
}

/** The vendor hears about it in the app once it is public (no email: a popular product would fill their inbox). */
async function tellVendor(review: ReviewDoc, productName: string): Promise<void> {
  try {
    const vendor = await Vendor.findById(review.vendorId);
    const owner = vendor ? await User.findById(vendor.userId) : null;
    if (!owner) return;
    const words = review.comment ? `"${review.comment.slice(0, 120)}${review.comment.length > 120 ? "..." : ""}"` : "They left no comment.";
    await getNotifier().notify(
      [{ id: String(owner._id), name: owner.name, email: owner.email }],
      { kind: "NEW_REVIEW", title: `New ${review.rating}-star review on ${productName}`, body: `${review.authorName} rated it ${review.rating} out of 5. ${words}`, link: "/vendor/products" },
      { channels: "in-app" },
    );
  } catch (err) {
    console.error("Could not tell the vendor about a new review:", err); // never undoes the review
  }
}
