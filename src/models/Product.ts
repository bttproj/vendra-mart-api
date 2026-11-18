import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

const isInt = { validator: Number.isInteger, message: "{PATH} must be a whole number" };

const productSchema = new Schema(
  {
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true, index: true },
    // Copied from the vendor's pickup city so listings can filter by city without a join.
    cityId: { type: Schema.Types.ObjectId, ref: "City", required: true, index: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 140 },
    slug: { type: String, required: true, unique: true, lowercase: true },
    description: { type: String, trim: true, maxlength: 2000, default: "" },
    // Money is integer kobo everywhere.
    priceKobo: { type: Number, required: true, min: 100, validate: isInt },
    stock: { type: Number, required: true, min: 0, default: 0, validate: isInt },
    images: [{ _id: false, url: { type: String, required: true }, publicId: { type: String, required: true } }],
    isActive: { type: Boolean, default: true },
    soldCount: { type: Number, default: 0, min: 0, validate: isInt },
    // Units the vendor has put up in all: the first stock plus what they added later. Missing on older products, which count
    // as stock plus sold (see domain/stock.ts), so it needs no migration.
    uploadedCount: { type: Number, min: 0, validate: isInt },
    // Customer ratings: how many, and the stars added up. The average is worked out from these (domain/rating.ts), so a new
    // review is two increments, not a recount.
    ratingCount: { type: Number, default: 0, min: 0, validate: isInt },
    ratingSum: { type: Number, default: 0, min: 0, validate: isInt },
  },
  { timestamps: true },
);

productSchema.index({ createdAt: -1 });
productSchema.index({ soldCount: -1 });

export type ProductAttrs = InferSchemaType<typeof productSchema>;
export type ProductDoc = HydratedDocument<ProductAttrs>;
export const Product = model("Product", productSchema);
