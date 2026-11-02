import { Router } from "express";
import { singleFile } from "../../middleware/upload.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { created, ok } from "../../utils/respond.js";
import { detectImageKind } from "../../utils/fileType.js";
import { getImageStorage } from "../../services/storage/index.js";
import { storageFolder } from "../../utils/storagePaths.js";
import { ownVendor } from "../../models/Vendor.js";
import { getVendorForUser } from "../vendors/vendor.service.js";

// Mounted under /api/vendor/uploads, so the vendor role check has already run.
export const vendorUploadRouter = Router();

vendorUploadRouter.post(
  "/image",
  singleFile,
  asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user!._id);
    if (vendor.status === "SUSPENDED") throw AppError.forbidden("Your store is suspended. Contact support.");
    if (!req.file) throw AppError.validation("Choose an image to upload");

    // Trust the bytes, not the filename or the browser-sent mimetype.
    if (!detectImageKind(req.file.buffer)) {
      throw AppError.validation("Only JPG, PNG or WebP images are allowed");
    }

    const stored = await getImageStorage().upload(req.file.buffer, { folder: storageFolder("vendors", vendor._id, "products") });
    created(res, stored);
  }),
);

/** The store's logo: stored in Cloudinary, its address saved on the store, and the logo it replaces removed. */
vendorUploadRouter.post(
  "/logo",
  singleFile,
  asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user!._id);
    if (vendor.status === "SUSPENDED") throw AppError.forbidden("Your store is suspended. Contact support.");
    if (!req.file) throw AppError.validation("Choose an image to upload");
    if (!detectImageKind(req.file.buffer)) throw AppError.validation("Only JPG, PNG or WebP images are allowed");

    const storage = getImageStorage();
    const stored = await storage.upload(req.file.buffer, { folder: storageFolder("vendors", vendor._id, "logo") });
    const previous = vendor.logoPublicId;
    vendor.logo = stored.url;
    vendor.logoPublicId = stored.publicId;
    await vendor.save();
    if (previous) await storage.remove(previous).catch(() => {});
    ok(res, ownVendor(vendor));
  }),
);
