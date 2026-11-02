import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

export const VENDOR_STATUSES = ["PENDING", "APPROVED", "SUSPENDED"] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

const vendorSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    businessName: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true, lowercase: true },
    ownerName: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    cacNumber: { type: String, trim: true, maxlength: 30 },
    // National Identification Number (11 digits) and a copy of the NIN slip. Private: admins only, never shown to shoppers.
    // Unique when present, so one person cannot open several stores on the same identity.
    nin: { type: String, trim: true, unique: true, sparse: true },
    ninSlip: {
      publicId: { type: String },
      mime: { type: String },
      resourceType: { type: String },
      uploadedAt: { type: Date },
    },
    description: { type: String, trim: true, maxlength: 600 },
    // The store's logo: the address saved here, and the id needed to delete the file from Cloudinary when it is replaced.
    logo: { type: String },
    logoPublicId: { type: String },
    bank: {
      bankName: { type: String, required: true, trim: true, maxlength: 80 },
      accountNumber: { type: String, required: true, trim: true },
      accountName: { type: String, required: true, trim: true, maxlength: 120 },
    },
    pickup: {
      line: { type: String, required: true, trim: true, maxlength: 300 },
      placeId: { type: String, trim: true },
      lat: { type: Number, required: true, min: -90, max: 90 },
      lng: { type: Number, required: true, min: -180, max: 180 },
      cityId: { type: Schema.Types.ObjectId, ref: "City", required: true, index: true },
    },
    status: { type: String, enum: VENDOR_STATUSES, default: "PENDING", index: true },
    statusReason: { type: String, trim: true, maxlength: 300 },
    // Short-lived lock taken while a payout request is processed, so a double click or two tabs cannot
    // create two partial payouts. It expires on its own, so a crash can never leave a vendor locked out.
    payoutLockUntil: { type: Date },
    approvedAt: { type: Date },
  },
  { timestamps: true },
);

export type VendorAttrs = InferSchemaType<typeof vendorSchema>;
export type VendorDoc = HydratedDocument<VendorAttrs>;
export const Vendor = model("Vendor", vendorSchema);

export const maskAccount = (n: string) => `•••• ${n.slice(-4)}`;
/** Only the last four digits of a NIN are ever shown back to the vendor. */
export const maskNin = (n: string) => `*******${n.slice(-4)}`;

/** What the public storefront may see. Never bank details, CAC number, phone or email. */
export const publicVendor = (v: VendorDoc) => ({
  id: String(v._id),
  slug: v.slug,
  businessName: v.businessName,
  description: v.description ?? null,
  logo: v.logo ?? null,
  cityId: String(v.pickup!.cityId),
  pickupArea: v.pickup!.line,
});

/** The vendor's own view of their profile. Bank account number is masked. */
export const ownVendor = (v: VendorDoc) => ({
  id: String(v._id),
  slug: v.slug,
  businessName: v.businessName,
  ownerName: v.ownerName,
  phone: v.phone,
  email: v.email,
  cacNumber: v.cacNumber ?? null,
  ninMasked: v.nin ? maskNin(v.nin) : null,
  hasNinSlip: Boolean(v.ninSlip?.publicId),
  ninSlipUploadedAt: v.ninSlip?.uploadedAt ?? null,
  /** Identity can be changed while the store is waiting for approval, or while nothing is on file yet. After that, support must do it. */
  canEditIdentity: v.status === "PENDING" || !v.nin || !v.ninSlip?.publicId,
  description: v.description ?? null,
  logo: v.logo ?? null,
  status: v.status,
  statusReason: v.statusReason ?? null,
  bank: { bankName: v.bank!.bankName, accountName: v.bank!.accountName, accountMasked: maskAccount(v.bank!.accountNumber) },
  pickup: {
    line: v.pickup!.line,
    placeId: v.pickup!.placeId ?? null,
    lat: v.pickup!.lat,
    lng: v.pickup!.lng,
    cityId: String(v.pickup!.cityId),
  },
});
