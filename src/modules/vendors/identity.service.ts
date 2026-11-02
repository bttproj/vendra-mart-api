import type { Response } from "express";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";
import { classifyDocument } from "../../utils/fileType.js";
import type { VendorDoc } from "../../models/Vendor.js";
import { getPrivateStorage } from "../../services/storage/index.js";
import { storageFolder } from "../../utils/storagePaths.js";
import { assertNinFree } from "./vendor.service.js";

// A vendor's NIN and the slip that backs it up. The slip is a private file (never a public address): it is stored the
// same way payout receipts are, and the only way out is the routes below, which check who is asking.

/** Open while the store waits for approval, or while the NIN or the slip is still missing. After that only support changes it. */
export function assertCanEditIdentity(vendor: VendorDoc) {
  const locked = vendor.status !== "PENDING" && Boolean(vendor.nin) && Boolean(vendor.ninSlip?.publicId);
  if (locked) throw AppError.forbidden("Your identity details cannot be changed once your store is approved. Contact support to change them.");
}

export async function setNin(vendor: VendorDoc, nin: string) {
  assertCanEditIdentity(vendor);
  await assertNinFree(nin, vendor._id);
  vendor.nin = nin;
  await vendor.save();
  return vendor;
}

/** Stores the slip privately and replaces any earlier one. Accepts an image (JPG, PNG, WebP) or a PDF, judged by the file's bytes. */
export async function saveNinSlip(vendor: VendorDoc, buffer: Buffer) {
  assertCanEditIdentity(vendor);
  const kind = classifyDocument(buffer);
  if (!kind) throw AppError.validation("Upload the NIN slip as an image (JPG, PNG, WebP) or a PDF", [{ path: "file", message: "The NIN slip must be an image or a PDF" }]);

  const storage = getPrivateStorage();
  const stored = await storage.put(buffer, { folder: storageFolder("vendors", vendor._id, "identity"), mime: kind.mime, ext: kind.ext });
  const previous = vendor.ninSlip?.publicId ? { id: vendor.ninSlip.publicId, type: vendor.ninSlip.resourceType ?? undefined } : null;

  vendor.ninSlip = { publicId: stored.publicId, mime: kind.mime, resourceType: stored.resourceType, uploadedAt: new Date() };
  await vendor.save();
  if (previous) await storage.remove(previous.id, previous.type).catch(() => {});
  return vendor;
}

/** Sends the slip to the caller, who the route has already checked is the owner or an admin. A signed storage link comes back as JSON. */
export async function sendNinSlip(res: Response, vendor: VendorDoc) {
  const slip = vendor.ninSlip;
  if (!slip?.publicId) throw AppError.notFound("No NIN slip has been uploaded");
  const file = await getPrivateStorage().open(slip.publicId, slip.mime ?? "application/octet-stream", slip.resourceType ?? undefined);
  if (file.kind === "redirect") return ok(res, { url: file.url });
  res.setHeader("Content-Type", file.mime);
  res.setHeader("Content-Disposition", `inline; filename="nin-slip.${file.mime === "application/pdf" ? "pdf" : file.mime.split("/")[1]}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(file.data);
}

