import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";
import { PERMISSIONS, STAFF_TITLES } from "../domain/permissions.js";

export const ROLES = ["CUSTOMER", "VENDOR", "ADMIN", "HANDLER"] as const;
export type Role = (typeof ROLES)[number];

const userSchema = new Schema(
  {
    role: { type: String, enum: ROLES, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    isActive: { type: Boolean, default: true },
    // Has the person proved they can read this inbox? New sign-ups start false and confirm by email. The default is true so
    // that accounts which existed before this was added (and staff made by an admin) count as confirmed.
    emailVerified: { type: Boolean, default: true },
    emailVerifiedAt: { type: Date },
    // Back-office staff only (role ADMIN). No title means a super admin who can do everything; a title (operations manager,
    // finance manager...) means the account may open only the areas listed in `permissions`. See domain/permissions.ts.
    staffTitle: { type: String, enum: STAFF_TITLES },
    permissions: { type: [String], default: undefined },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;
export const User = model("User", userSchema);

export function publicUser(u: Pick<UserDoc, "_id" | "role" | "name" | "email" | "phone" | "emailVerified"> & Partial<Pick<UserDoc, "staffTitle" | "permissions">>) {
  const base = { id: String(u._id), role: u.role, name: u.name, email: u.email, phone: u.phone, emailVerified: u.emailVerified };
  if (u.role !== "ADMIN") return base;
  // Lets the admin screens show only what this person may open. The API enforces it again on every request.
  const permissions: string[] = u.staffTitle ? PERMISSIONS.filter((p) => u.permissions?.includes(p)) : [...PERMISSIONS];
  return { ...base, staffTitle: u.staffTitle ?? null, isSuperAdmin: !u.staffTitle, permissions };
}
