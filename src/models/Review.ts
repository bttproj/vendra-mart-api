import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

export const REVIEW_STATUSES = ["PENDING", "APPROVED"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Is this review public? A review with no status was written before approval existed. */
export const isApprovedStatus = (status: string | null | undefined) => status !== "PENDING";

// One customer's rating and words about one product they have received. They can have only one per product (they edit it
// instead). The author's display name and the product's name are copied in, so the review still reads right if the account
// or the product changes or goes.
const reviewSchema = new Schema(
  {
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true, index: true },
    // The delivered sub-order that made the customer eligible.
    subOrderId: { type: Schema.Types.ObjectId, ref: "SubOrder", required: true },
    rating: { type: Number, required: true, min: 1, max: 5, validate: { validator: Number.isInteger, message: "{PATH} must be a whole number" } },
    comment: { type: String, trim: true, maxlength: 1000, default: "" },
    authorName: { type: String, required: true, trim: true, maxlength: 80 },
    productName: { type: String, required: true, trim: true, maxlength: 140 },
    // A new review waits for an admin to approve it. Only approved reviews are public and count towards the average. A review
    // saved before approval existed has no status, and counts as approved.
    status: { type: String, enum: REVIEW_STATUSES, default: "PENDING", index: true },
    approvedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

reviewSchema.index({ customerId: 1, productId: 1 }, { unique: true });
reviewSchema.index({ productId: 1, createdAt: -1 });
reviewSchema.index({ createdAt: -1 });

/** The filter for reviews shoppers may see and that count towards an average. */
export const APPROVED_FILTER = { status: { $ne: "PENDING" } } as const;

export type ReviewAttrs = InferSchemaType<typeof reviewSchema>;
export type ReviewDoc = HydratedDocument<ReviewAttrs>;
export const Review = model("Review", reviewSchema);

/** What a shopper sees of a review: the stars, the words, a short name and the date. Never an id, email or full name. */
export const publicReview = (r: ReviewDoc) => ({
  id: String(r._id),
  rating: r.rating,
  comment: r.comment ?? "",
  authorName: r.authorName,
  createdAt: r.createdAt,
  edited: r.updatedAt.getTime() - r.createdAt.getTime() > 1000,
});
