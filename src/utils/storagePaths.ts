import { env } from "../config/env.js";

/**
 * Every file VendraMart stores (product photos, banners, logos, payout receipts, NIN slips) lives under one root folder,
 * "vendramart" by default (CLOUDINARY_ROOT_FOLDER), so the Cloudinary media library stays tidy and the account can be
 * shared with other projects. `storageFolder("vendors", id, "products")` is "vendramart/vendors/<id>/products".
 */
export const STORAGE_ROOT = env.CLOUDINARY_ROOT_FOLDER;

export const storageFolder = (...parts: (string | { toString(): string })[]) => [STORAGE_ROOT, ...parts.map(String)].join("/");

/**
 * The folders a vendor's own images can be in. Files stored before the root folder existed ("vendors/<id>/...") are still theirs,
 * so both forms are accepted when a vendor attaches an image to a product.
 */
export const vendorFolderPrefixes = (vendorId: { toString(): string }) => [storageFolder("vendors", vendorId) + "/", `vendors/${vendorId}/`];
