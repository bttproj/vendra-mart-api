import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";
import { RETURN_REASONS, RETURN_STATUSES, RETURN_TYPES } from "../domain/returns.js";

const isInt = { validator: Number.isInteger, message: "{PATH} must be a whole number" };
const kobo = { type: Number, required: true, min: 0, validate: isInt };

// A customer's return or problem report about part of one delivery. Money is integer kobo. Names and amounts are copied in at
// the time, so the case still reads right if the product or the order changes later.
const returnSchema = new Schema(
  {
    number: { type: String, required: true, unique: true }, // RT-1001
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    orderNumber: { type: String, required: true },
    subOrderId: { type: Schema.Types.ObjectId, ref: "SubOrder", required: true, index: true },
    subOrderRef: { type: String, required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true, index: true },

    type: { type: String, enum: RETURN_TYPES, required: true },
    reason: { type: String, enum: RETURN_REASONS, required: true },
    description: { type: String, required: true, trim: true, maxlength: 1000 },
    items: [
      {
        _id: false,
        productId: { type: Schema.Types.ObjectId, required: true },
        name: { type: String, required: true },
        qty: { type: Number, required: true, min: 1, validate: isInt },
        unitPriceKobo: kobo,
        lineTotalKobo: kobo, // unit price x the quantity returned
        vendorEarningKobo: kobo, // the vendor's share of that, which a refund takes off their earnings
      },
    ],
    // Every unit of every line of the delivery: the delivery fee may then be refunded too.
    wholeDelivery: { type: Boolean, default: false },

    status: { type: String, enum: RETURN_STATUSES, default: "REQUESTED", index: true },
    decisionNote: { type: String, trim: true, maxlength: 500 }, // the admin's note on confirming, or the reason for rejecting
    decidedBy: { type: Schema.Types.ObjectId, ref: "User" },
    confirmedAt: Date,
    // The refund deadline of a confirmed case: 7 working days after it was confirmed. Not completed by then: the admin is told.
    windowEndsAt: { type: Date, index: true },
    overdueNotifiedAt: Date,
    rejectedAt: Date,
    cancelledAt: Date,
    completedAt: Date,
    refundKobo: { type: Number, min: 0, validate: isInt },
    refundNote: { type: String, trim: true, maxlength: 300 }, // where the refund was made, for example the Paystack reference
    restocked: { type: Boolean, default: false },
  },
  { timestamps: true },
);

returnSchema.index({ createdAt: -1 });

export type ReturnRequestAttrs = InferSchemaType<typeof returnSchema>;
export type ReturnRequestDoc = HydratedDocument<ReturnRequestAttrs>;
export const ReturnRequest = model("ReturnRequest", returnSchema);
