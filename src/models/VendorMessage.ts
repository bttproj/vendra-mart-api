import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

/**
 * An email an admin sent to a store's owner from the dashboard. Kept so the team can see what a vendor has been told, by
 * whom and when, and which messages did not go through. The name and address are copied in, so the record still reads
 * correctly if either changes later.
 */
const vendorMessageSchema = new Schema(
  {
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true, index: true },
    sentById: { type: Schema.Types.ObjectId, ref: "User", required: true },
    sentByName: { type: String, required: true },
    toName: { type: String, required: true },
    toEmail: { type: String, required: true },
    subject: { type: String, required: true, maxlength: 150 },
    body: { type: String, required: true, maxlength: 6000 },
    status: { type: String, enum: ["SENT", "FAILED"], required: true },
    // Why a message failed, for the admin. Never includes any key or secret.
    error: { type: String, maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export type VendorMessageAttrs = InferSchemaType<typeof vendorMessageSchema>;
export type VendorMessageDoc = HydratedDocument<VendorMessageAttrs>;
export const VendorMessage = model("VendorMessage", vendorMessageSchema);

export const presentVendorMessage = (m: VendorMessageDoc) => ({
  id: String(m._id),
  subject: m.subject,
  body: m.body,
  status: m.status,
  error: m.error ?? null,
  toEmail: m.toEmail,
  sentBy: m.sentByName,
  sentAt: m.createdAt,
});
