import { Router } from "express";
import { z } from "zod";
import { singleFile } from "../../middleware/upload.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { detectImageKind } from "../../utils/fileType.js";
import { created, ok } from "../../utils/respond.js";
import { escapeRegex, objectId } from "../../utils/zodCommon.js";
import { uniqueSlug } from "../../utils/slug.js";
import { storageFolder } from "../../utils/storagePaths.js";
import { Category, publicCategory, type CategoryDoc } from "../../models/Category.js";
import { Product } from "../../models/Product.js";
import { slugify, STARTER_CATEGORY_SLUGS } from "../../seed/reference.js";
import { getImageStorage } from "../../services/storage/index.js";

// Mounted under /api/admin/categories, so the ADMIN role check has already run. The public list is GET /api/categories.
export const adminCategoriesRouter = Router();

const present = (c: CategoryDoc, productCount: number) => ({
  ...publicCategory(c),
  sortOrder: c.sortOrder,
  /** True when the admin has set a picture, false when the standard stand-in is showing. */
  hasOwnImage: Boolean(c.image),
  productCount,
  /** The starter categories come back when the server starts, so they can be renamed but not deleted. */
  builtIn: STARTER_CATEGORY_SLUGS.includes(c.slug),
});

const name = z.string().trim().min(2, "Enter a category name").max(40, "Keep the name under 40 characters");
const image = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => /^https:\/\/[^\s]+$/i.test(v) || /^\/uploads\/[^\s]+$/.test(v) || /^http:\/\/localhost[:/][^\s]*$/.test(v), "Upload a picture for the category");
const body = z.object({ name, image: image.nullable().optional() }).strict();

async function counts() {
  const rows = await Product.aggregate<{ _id: unknown; n: number }>([{ $group: { _id: "$categoryId", n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

/** One category's name is its own: "fashion" and "Fashion " are the same. */
async function assertNameFree(text: string, exceptId?: string) {
  const clash = await Category.exists({ name: new RegExp(`^${escapeRegex(text)}$`, "i"), ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
  if (clash || (await Category.exists({ slug: slugify(text), ...(exceptId ? { _id: { $ne: exceptId } } : {}) }))) {
    throw AppError.conflict("There is already a category with that name.", [{ path: "name", message: "There is already a category with that name" }]);
  }
}

adminCategoriesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const [list, byCategory] = await Promise.all([Category.find().sort({ sortOrder: 1, name: 1 }), counts()]);
    ok(res, list.map((c) => present(c, byCategory.get(String(c._id)) ?? 0)));
  }),
);

adminCategoriesRouter.post(
  "/image",
  singleFile,
  asyncHandler(async (req, res) => {
    if (!req.file) throw AppError.validation("Choose an image to upload");
    if (!detectImageKind(req.file.buffer)) throw AppError.validation("Only JPG, PNG or WebP images are allowed");
    created(res, await getImageStorage().upload(req.file.buffer, { folder: storageFolder("categories") }));
  }),
);

adminCategoriesRouter.post(
  "/",
  validate({ body }),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;
    await assertNameFree(b.name);
    const last = await Category.findOne().sort({ sortOrder: -1 });
    const doc = await Category.create({ name: b.name, slug: await uniqueSlug(Category, b.name), image: b.image || undefined, sortOrder: (last?.sortOrder ?? 0) + 1 });
    created(res, present(doc, 0));
  }),
);

// Rename and change the picture. The slug (the address shoppers use) stays the same, so existing links keep working.
adminCategoriesRouter.put(
  "/:id",
  validate({ params: z.object({ id: objectId }), body }),
  asyncHandler(async (req, res) => {
    const doc = await Category.findById(req.validated.params.id);
    if (!doc) throw AppError.notFound("Category not found");
    const b = req.validated.body;
    await assertNameFree(b.name, String(doc._id));
    doc.name = b.name;
    if (b.image !== undefined) doc.image = b.image ?? undefined; // null goes back to the standard picture
    await doc.save();
    ok(res, present(doc, (await counts()).get(String(doc._id)) ?? 0));
  }),
);

adminCategoriesRouter.delete(
  "/:id",
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const doc = await Category.findById(req.validated.params.id);
    if (!doc) throw AppError.notFound("Category not found");
    if (STARTER_CATEGORY_SLUGS.includes(doc.slug)) throw AppError.conflict("This is one of the starter categories. You can rename it, but it cannot be deleted.");
    const n = await Product.countDocuments({ categoryId: doc._id });
    if (n > 0) throw AppError.conflict(`${n} ${n === 1 ? "product is" : "products are"} in this category. Move or remove ${n === 1 ? "it" : "them"} first.`);
    await doc.deleteOne();
    ok(res, { id: String(doc._id) });
  }),
);
