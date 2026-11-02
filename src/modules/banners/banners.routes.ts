import { Router } from "express";
import { z } from "zod";
import { singleFile } from "../../middleware/upload.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { detectImageKind } from "../../utils/fileType.js";
import { created, ok } from "../../utils/respond.js";
import { objectId } from "../../utils/zodCommon.js";
import { BANNER_PLACEMENTS, Banner, liveBannerFilter, presentBanner, publicBanner } from "../../models/Banner.js";
import { getImageStorage } from "../../services/storage/index.js";
import { storageFolder } from "../../utils/storagePaths.js";

/** Public: the banners showing right now. */
export const bannersRouter = Router();

bannersRouter.get(
  "/banners",
  asyncHandler(async (_req, res) => {
    const banners = await Banner.find(liveBannerFilter()).sort({ sortOrder: 1, createdAt: -1 });
    res.set("Cache-Control", "public, max-age=60");
    ok(res, banners.map(publicBanner));
  }),
);

/** A page on this website, or a full https address. Anything else (javascript:, data:, //host) is refused. */
const link = z
  .string()
  .trim()
  .min(1, "Enter where the banner should go")
  .max(500)
  .refine((v) => (v.startsWith("/") && !v.startsWith("//") && !v.includes("\\")) || /^https:\/\/[^\s]+$/i.test(v), "Use a page on this website, like /category/?slug=fashion, or a full https:// address");

const image = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => /^https:\/\/[^\s]+$/i.test(v) || /^\/uploads\/[^\s]+$/.test(v) || /^http:\/\/localhost[:/][^\s]*$/.test(v), "Upload a picture for the banner");

const optionalDate = z
  .union([z.string().trim().min(1), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === null) return v === null ? null : undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "That date is not valid" });
      return z.NEVER;
    }
    return d;
  });

const bannerBody = z
  .object({
    placement: z.enum(BANNER_PLACEMENTS),
    title: z.string().trim().min(1, "Enter a title").max(80, "Keep the title under 80 characters"),
    subtitle: z.string().trim().max(140, "Keep the line under 140 characters").optional(),
    ctaLabel: z.string().trim().max(24, "Keep the button words under 24 characters").optional(),
    link,
    image,
    isActive: z.boolean().default(true),
    startsAt: optionalDate,
    endsAt: optionalDate,
  })
  .strict()
  .refine((b) => !(b.startsAt && b.endsAt) || b.endsAt > b.startsAt, { message: "The end must be after the start", path: ["endsAt"] });

/** Mounted under /api/admin, behind requireRole("ADMIN"). */
export const adminBannersRouter = Router();

adminBannersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const banners = await Banner.find().sort({ placement: 1, sortOrder: 1, createdAt: -1 });
    ok(res, banners.map((b) => presentBanner(b, now)));
  }),
);

adminBannersRouter.post(
  "/image",
  singleFile,
  asyncHandler(async (req, res) => {
    if (!req.file) throw AppError.validation("Choose an image to upload");
    if (!detectImageKind(req.file.buffer)) throw AppError.validation("Only JPG, PNG or WebP images are allowed");
    created(res, await getImageStorage().upload(req.file.buffer, { folder: storageFolder("banners") }));
  }),
);

adminBannersRouter.post(
  "/",
  validate({ body: bannerBody }),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;
    // New banners go to the end of their group.
    const last = await Banner.findOne({ placement: b.placement }).sort({ sortOrder: -1 });
    const doc = await Banner.create({ ...b, sortOrder: (last?.sortOrder ?? -1) + 1 });
    created(res, presentBanner(doc));
  }),
);

/** Sets the order of a group: the ids in the order they should appear. Registered before /:id on purpose. */
adminBannersRouter.put(
  "/order",
  validate({ body: z.object({ ids: z.array(objectId).min(1).max(100) }).strict() }),
  asyncHandler(async (req, res) => {
    const { ids } = req.validated.body as { ids: string[] };
    if (new Set(ids).size !== ids.length) throw AppError.validation("Each banner can appear once");
    const found = await Banner.countDocuments({ _id: { $in: ids } });
    if (found !== ids.length) throw AppError.notFound("One of those banners no longer exists");
    await Banner.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { sortOrder: i } } } })));
    const banners = await Banner.find().sort({ placement: 1, sortOrder: 1, createdAt: -1 });
    ok(res, banners.map((b) => presentBanner(b)));
  }),
);

adminBannersRouter.put(
  "/:id",
  validate({ params: z.object({ id: objectId }), body: bannerBody }),
  asyncHandler(async (req, res) => {
    const doc = await Banner.findById(req.validated.params.id);
    if (!doc) throw AppError.notFound("Banner not found");
    const b = req.validated.body;
    doc.placement = b.placement;
    doc.title = b.title;
    doc.subtitle = b.subtitle || undefined;
    doc.ctaLabel = b.ctaLabel || undefined;
    doc.link = b.link;
    doc.image = b.image;
    doc.isActive = b.isActive;
    doc.startsAt = b.startsAt ?? undefined;
    doc.endsAt = b.endsAt ?? undefined;
    await doc.save();
    ok(res, presentBanner(doc));
  }),
);

adminBannersRouter.patch(
  "/:id",
  validate({ params: z.object({ id: objectId }), body: z.object({ isActive: z.boolean() }).strict() }),
  asyncHandler(async (req, res) => {
    const doc = await Banner.findById(req.validated.params.id);
    if (!doc) throw AppError.notFound("Banner not found");
    doc.isActive = req.validated.body.isActive;
    await doc.save();
    ok(res, presentBanner(doc));
  }),
);

adminBannersRouter.delete(
  "/:id",
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const doc = await Banner.findByIdAndDelete(req.validated.params.id);
    if (!doc) throw AppError.notFound("Banner not found");
    ok(res, { id: String(doc._id) });
  }),
);
