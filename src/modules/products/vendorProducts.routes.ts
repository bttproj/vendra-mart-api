import { Router } from "express";
import { PLACEHOLDER_PREFIX } from "../../config/placeholderImages.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { created, ok } from "../../utils/respond.js";
import { escapeRegex } from "../../utils/zodCommon.js";
import { uniqueSlug } from "../../utils/slug.js";
import { calculateLineEarnings } from "../../domain/commission.js";
import { ratingSummary } from "../../domain/rating.js";
import { uploadedAfterEdit, uploadedUnits } from "../../domain/stock.js";
import { Category } from "../../models/Category.js";
import { getPricing } from "../../models/Settings.js";
import { Product, type ProductDoc } from "../../models/Product.js";
import type { VendorDoc } from "../../models/Vendor.js";
import { getImageStorage } from "../../services/storage/index.js";
import { vendorFolderPrefixes } from "../../utils/storagePaths.js";
import { getVendorForUser } from "../vendors/vendor.service.js";
import { createProductSchema, idParams, updateProductSchema, vendorListQuery } from "./product.schemas.js";

export const vendorProductsRouter = Router();

/** Best-effort delete from storage. Shared placeholder photos are never in our storage, so they are skipped. */
function removeStored(publicId: string) {
  if (publicId.startsWith(PLACEHOLDER_PREFIX)) return;
  getImageStorage().remove(publicId).catch(() => {});
}

/** A suspended store keeps read access but cannot change its catalogue. */
function assertCanWrite(vendor: VendorDoc) {
  if (vendor.status === "SUSPENDED") throw AppError.forbidden("Your store is suspended. Contact support.");
}

/** Images must be ones this vendor uploaded; stops a vendor attaching another store's files. */
function assertOwnImages(vendor: VendorDoc, images: { publicId: string }[]) {
  for (const img of images) {
    // Stand-in demo photos (placeholder/...) are shared and harmless, so any store may keep them.
    const own = vendorFolderPrefixes(vendor._id).some((prefix) => img.publicId.startsWith(prefix));
    if (!own && !img.publicId.startsWith(PLACEHOLDER_PREFIX)) {
      throw AppError.validation("One of the images was not uploaded by your store", [{ path: "images", message: "Invalid image" }]);
    }
  }
}

async function assertCategory(id: string) {
  if (!(await Category.exists({ _id: id }))) {
    throw AppError.validation("Pick a valid category", [{ path: "categoryId", message: "Pick a valid category" }]);
  }
}

/** `bps` is the service fee VendraMart keeps, so the vendor sees both the fee and what they receive for one item. */
const present = (p: ProductDoc, bps: number) => ({
  id: String(p._id),
  slug: p.slug,
  name: p.name,
  description: p.description,
  categoryId: String(p.categoryId),
  priceKobo: p.priceKobo,
  stock: p.stock,
  images: p.images.map((i) => ({ url: i.url, publicId: i.publicId })),
  isActive: p.isActive,
  serviceFeeKobo: calculateLineEarnings(p.priceKobo, 1, bps).commissionKobo,
  youReceiveKobo: calculateLineEarnings(p.priceKobo, 1, bps).vendorEarningKobo,
  soldCount: p.soldCount,
  rating: ratingSummary(p.ratingSum, p.ratingCount),
  uploadedCount: uploadedUnits(p),
  createdAt: p.createdAt,
});

async function ownProduct(vendor: VendorDoc, id: string) {
  // Always scoped by vendorId: another vendor's id looks exactly like a missing one.
  const product = await Product.findOne({ _id: id, vendorId: vendor._id });
  if (!product) throw AppError.notFound("Product not found");
  return product;
}

vendorProductsRouter.get(
  "/",
  validate({ query: vendorListQuery }),
  asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user!._id);
    const { page, limit, q } = req.validated.query;
    const filter: Record<string, unknown> = { vendorId: vendor._id };
    if (q) filter.name = new RegExp(escapeRegex(q), "i");
    const [items, total] = await Promise.all([
      Product.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Product.countDocuments(filter),
    ]);
    const { commissionBps } = await getPricing();
    ok(res, items.map((p) => present(p, commissionBps)), { page, limit, total });
  }),
);

vendorProductsRouter.post(
  "/",
  validate({ body: createProductSchema }),
  asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user!._id);
    assertCanWrite(vendor);
    const input = req.validated.body;
    assertOwnImages(vendor, input.images);
    await assertCategory(input.categoryId);

    const product = await Product.create({
      ...input,
      uploadedCount: input.stock,
      vendorId: vendor._id,
      cityId: vendor.pickup!.cityId,
      slug: await uniqueSlug(Product, input.name),
    });
    created(res, present(product, (await getPricing()).commissionBps));
  }),
);

vendorProductsRouter.get(
  "/:id",
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user!._id);
    ok(res, present(await ownProduct(vendor, req.validated.params.id), (await getPricing()).commissionBps));
  }),
);

vendorProductsRouter.patch(
  "/:id",
  validate({ params: idParams, body: updateProductSchema }),
  asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user!._id);
    assertCanWrite(vendor);
    const product = await ownProduct(vendor, req.validated.params.id);
    const input = req.validated.body;

    if (input.images) assertOwnImages(vendor, input.images);
    if (input.categoryId) await assertCategory(input.categoryId);

    // Remove files that are no longer referenced (best effort, never blocks the save).
    const dropped = input.images ? product.images.filter((old) => !input.images!.some((n: { publicId: string }) => n.publicId === old.publicId)) : [];

    // Adding stock adds to what was uploaded; a correction downwards takes from it. Worked out before the stock is overwritten.
    if (input.stock !== undefined && input.stock !== product.stock) product.uploadedCount = uploadedAfterEdit(product, input.stock);
    Object.assign(product, input);
    await product.save();
    for (const img of dropped) removeStored(img.publicId);
    ok(res, present(product, (await getPricing()).commissionBps));
  }),
);

vendorProductsRouter.delete(
  "/:id",
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const vendor = await getVendorForUser(req.user!._id);
    assertCanWrite(vendor);
    const product = await ownProduct(vendor, req.validated.params.id);
    // Orders keep their own snapshot of name and price (Phase 4), so deleting the product is safe.
    await product.deleteOne();
    for (const img of product.images) removeStored(img.publicId);
    ok(res, { deleted: true });
  }),
);
