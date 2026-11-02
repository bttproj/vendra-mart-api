import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const EMAIL_TOKEN_PURPOSES = ["VERIFY_EMAIL", "RESET_PASSWORD"] as const;
export type EmailTokenPurpose = (typeof EMAIL_TOKEN_PURPOSES)[number];

/**
 * A one-time link sent by email (confirm an address, reset a password). Only a hash of the token is stored, so a copy of
 * the database cannot be used to take over an account. The record removes itself shortly after it expires.
 */
const emailTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    purpose: { type: String, enum: EMAIL_TOKEN_PURPOSES, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 3600 } },
    usedAt: { type: Date },
  },
  { timestamps: true },
);

export type EmailTokenAttrs = InferSchemaType<typeof emailTokenSchema>;
export type EmailTokenDoc = HydratedDocument<EmailTokenAttrs>;
export const EmailToken = model("EmailToken", emailTokenSchema);
