import { Router } from "express";
import type { SortOrder } from "mongoose";
import { z } from "zod";
import { DEFAULT_LOW_STOCK, stockLevel, uploadedUnits } from "../../domain/stock.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ok } from "../../utils/respond.js";
import { escapeRegex, objectId, pagination } from "../../utils/zodCommon.js";
import { Category } from "../../models/Category.js";
import { City } from "../../models/City.js";
import { Product, type ProductDoc } from "../../models/Product.js";
import { Vendor } from "../../models/Vendor.js";

// Mounted under /api/admin/products, behind requireRole("ADMIN") and the catalogue or vendors area.
// Read only: the admin sees every store's products and stock, and the stores keep changing their own.
export const adminProductsRouter = Router();

const lowAt = z.coerce.number().int().min(1).max(1000).default(DEFAULT_LOW_STOCK);

const listQuery = pagination.extend({
  // Matches the product's name or the store's name.
  q: z.string().trim().max(100).optional(),
  vendorId: objectId.optional(),
  // out: none left. low: some left, but lowAt or fewer. attention: out or low.
  stock: z.enum(["all", "low", "out", "attention"]).default("all"),
  lowAt,
  sort: z.enum(["newest", "stock_asc", "stock_desc", "sold_desc", "name"]).default("newest"),
});

type Sort = "newest" | "stock_asc" | "stock_desc" | "sold_desc" | "name";
const SORTS: Record<Sort, Record<string, SortOrder>> = {
  newest: { createdAt: -1, _id: -1 },
  stock_asc: { stock: 1, soldCount: -1, _id: 1 },
  stock_desc: { stock: -1, _id: 1 },
  sold_desc: { soldCount: -1, _id: 1 },
  name: { name: 1, _id: 1 },
};

function stockFilter(stock: "all" | "low" | "out" | "attention", low: number): Record<string, unknown> {
  if (stock === "out") return { stock: 0 };
  if (stock === "low") return { stock: { $gt: 0, $lte: low } };
  if (stock === "attention") return { stock: { $lte: low } };
  return {};
}

function present(p: ProductDoc, lookups: { vendors: Map<string, VendorRow>; categories: Map<string, string> }, low: number) {
  const vendor = lookups.vendors.get(String(p.vendorId));
  return {
    id: String(p._id),
    slug: p.slug,
    name: p.name,
    image: p.images[0]?.url ?? null,
    category: lookups.categories.get(String(p.categoryId)) ?? null,
    priceKobo: p.priceKobo,
    // Hidden by the vendor: not on the storefront, but still their stock.
    isActive: p.isActive,
    // Units put up in all, how many are left to buy, and how many have sold.
    uploaded: uploadedUnits(p),
    left: p.stock,
    sold: p.soldCount,
    level: stockLevel(p.stock, low),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    vendor: vendor ?? null,
  };
}

interface VendorRow {
  id: string;
  businessName: string;
  slug: string;
  status: string;
  ownerName: string;
  phone: string;
  email: string;
  address: string;
  city: string | null;
}

async function loadVendors(ids: unknown[]): Promise<Map<string, VendorRow>> {
  const vendors = await Vendor.find({ _id: { $in: ids } });
  const cities = await City.find({ _id: { $in: vendors.map((v) => v.pickup!.cityId) } }).select("name");
  const cityName = new Map(cities.map((c) => [String(c._id), c.name]));
  return new Map(
    vendors.map((v) => [
      String(v._id),
      {
        id: String(v._id),
        businessName: v.businessName,
        slug: v.slug,
        status: v.status,
        ownerName: v.ownerName,
        phone: v.phone,
        email: v.email,
        address: v.pickup!.line,
        city: cityName.get(String(v.pickup!.cityId)) ?? null,
      },
    ]),
  );
}

adminProductsRouter.get(
  "/",
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, vendorId, stock, lowAt: low, sort } = req.validated.query;
    const filter: Record<string, unknown> = stockFilter(stock, low);
    if (vendorId) filter.vendorId = vendorId;
    if (q) {
      const re = new RegExp(escapeRegex(q), "i");
      const stores = await Vendor.find({ businessName: re }).distinct("_id");
      filter.$or = [{ name: re }, { vendorId: { $in: stores } }];
    }

    const [items, total] = await Promise.all([
      Product.find(filter)
        .sort(SORTS[sort as Sort])
        .skip((page - 1) * limit)
        .limit(limit),
      Product.countDocuments(filter),
    ]);

    const [vendors, categories] = await Promise.all([
      loadVendors([...new Set(items.map((p) => String(p.vendorId)))]),
      Category.find({ _id: { $in: items.map((p) => p.categoryId) } }).select("name"),
    ]);
    const lookups = { vendors, categories: new Map(categories.map((c) => [String(c._id), c.name])) };
    ok(res, items.map((p) => present(p, lookups, low)), { page, limit, total });
  }),
);

// The numbers across the tabs and the cards above the list: how many products, how many are out or running low, how many
// stores that touches, and the units left and sold in all.
adminProductsRouter.get(
  "/summary",
  validate({ query: z.object({ lowAt }) }),
  asyncHandler(async (req, res) => {
    const low = req.validated.query.lowAt;
    const [totals] = await Product.aggregate<{ products: number; out: number; low: number; unitsLeft: number; unitsSold: number }>([
      {
        $group: {
          _id: null,
          products: { $sum: 1 },
          out: { $sum: { $cond: [{ $lte: ["$stock", 0] }, 1, 0] } },
          low: { $sum: { $cond: [{ $and: [{ $gt: ["$stock", 0] }, { $lte: ["$stock", low] }] }, 1, 0] } },
          unitsLeft: { $sum: "$stock" },
          unitsSold: { $sum: "$soldCount" },
        },
      },
    ]);
    const stores = await Product.distinct("vendorId", { stock: { $lte: low } });
    ok(res, {
      lowAt: low,
      products: totals?.products ?? 0,
      outOfStock: totals?.out ?? 0,
      runningLow: totals?.low ?? 0,
      storesNeedingStock: stores.length,
      unitsLeft: totals?.unitsLeft ?? 0,
      unitsSold: totals?.unitsSold ?? 0,
    });
  }),
);
