import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

const isIntOrNull = { validator: (v: unknown) => v === null || v === undefined || Number.isInteger(v), message: "{PATH} must be a whole number or empty" };

const citySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    isActive: { type: Boolean, default: false, index: true },
    center: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },
    radiusKm: { type: Number, required: true, min: 1 },
    sortOrder: { type: Number, default: 0 },
    // This city's own delivery fares, in kobo. Null means "use the platform price" set in the pricing form. A minimum of 0 means no minimum here.
    pricePerKmKobo: { type: Number, min: 0, validate: isIntOrNull, default: null },
    minDeliveryFeeKobo: { type: Number, min: 0, validate: isIntOrNull, default: null },
  },
  { timestamps: true },
);

export type CityAttrs = InferSchemaType<typeof citySchema>;
export type CityDoc = HydratedDocument<CityAttrs>;
export const City = model("City", citySchema);

export const publicCity = (c: CityDoc) => ({
  id: String(c._id),
  name: c.name,
  slug: c.slug,
  isActive: c.isActive,
});

/** Shape the pure geo helpers expect. */
export const cityArea = (c: CityDoc) => ({
  id: String(c._id),
  center: { lat: c.center!.lat, lng: c.center!.lng },
  radiusKm: c.radiusKm,
  isActive: c.isActive,
  doc: c,
});
