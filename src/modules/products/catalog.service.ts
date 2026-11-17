import type { SortOrder } from "mongoose";
import { Category, publicCategory, type CategoryDoc } from "../../models/Category.js";
import { City } from "../../models/City.js";
import { Product, type ProductDoc } from "../../models/Product.js";
import { publicVendor, Vendor, type VendorDoc } from "../../models/Vendor.js";
import { escapeRegex } from "../../utils/zodCommon.js";
import { productPlaceholder } from "../../config/placeholderImages.js";

export interface CatalogFilter {
  q?: string;
  city?: string;
  category?: string;
  vendor?: string;
  sort: "newest" | "popular" | "price_asc" | "price_desc";
  page: number;
  limit: number;
}

/**
 * Who is allowed to appear on the storefront: APPROVED vendors whose pickup city is live.
 * A pending, suspended, or coming-soon-city vendor never shows up here, so none of their
 * products can be listed or opened.
 */
export async function visibleVendors(opts: { city?: string; vendorSlug?: string; nameQuery?: string } = {}): Promise<VendorDoc[]> {
  const cityFilter = opts.city ? { slug: opts.city.toLowerCase() } : {};
  const cities = await City.find({ isActive: true, ...cityFilter }).select("_id");
  if (cities.length === 0) return [];

  const filter: Record<string, unknown> = {
    status: "APPROVED",
    "pickup.cityId": { $in: cities.map((c) => c._id) },
  };
  if (opts.vendorSlug) filter.slug = opts.vendorSlug.toLowerCase();
  if (opts.nameQuery) filter.businessName = new RegExp(escapeRegex(opts.nameQuery), "i");
  return Vendor.find(filter);
}

/** The name of the city each store is in, by the store's id, for showing "Ibadan" beside a store. */
export async function cityNames(vendors: VendorDoc[]): Promise<Map<string, string>> {
  const cities = await City.find({ _id: { $in: [...new Set(vendors.map((v) => String(v.pickup!.cityId)))] } }).select("name");
  const byId = new Map(cities.map((c) => [String(c._id), c.name]));
  return new Map(vendors.map((v) => [String(v._id), byId.get(String(v.pickup!.cityId)) ?? ""]).filter(([, name]) => name) as [string, string][]);
}

const SORTS: Record<CatalogFilter["sort"], Record<string, SortOrder>> = {
  newest: { createdAt: -1 },
  popular: { soldCount: -1, createdAt: -1 },
  price_asc: { priceKobo: 1, _id: 1 },
  price_desc: { priceKobo: -1, _id: 1 },
};

export function presentCard(p: ProductDoc, vendor: VendorDoc, category?: CategoryDoc) {
  return {
    id: String(p._id),
    slug: p.slug,
    name: p.name,
    priceKobo: p.priceKobo,
    stock: p.stock,
    inStock: p.stock > 0,
    image: p.images[0]?.url ?? productPlaceholder(category?.slug),
    vendor: { slug: vendor.slug, businessName: vendor.businessName },
    category: category ? { slug: category.slug, name: category.name } : null,
  };
}

async function toCards(products: ProductDoc[]) {
  const [vendors, categories] = await Promise.all([
    Vendor.find({ _id: { $in: [...new Set(products.map((p) => String(p.vendorId)))] } }),
    Category.find({ _id: { $in: [...new Set(products.map((p) => String(p.categoryId)))] } }),
  ]);
  const vMap = new Map(vendors.map((v) => [String(v._id), v]));
  const cMap = new Map(categories.map((c) => [String(c._id), c]));
  return products.flatMap((p) => {
    const v = vMap.get(String(p.vendorId));
    return v ? [presentCard(p, v, cMap.get(String(p.categoryId)))] : [];
  });
}

export async function searchProducts(f: CatalogFilter) {
  const vendors = await visibleVendors({ city: f.city, vendorSlug: f.vendor });
  const vendorIds = vendors.map((v) => v._id);
  const empty = { items: [], total: 0 };
  if (vendorIds.length === 0) return empty;

  const and: Record<string, unknown>[] = [{ vendorId: { $in: vendorIds } }, { isActive: true }];

  if (f.category) {
    const category = await Category.findOne({ slug: f.category.toLowerCase() });
    if (!category) return empty;
    and.push({ categoryId: category._id });
  }

  if (f.q) {
    const rx = new RegExp(escapeRegex(f.q), "i");
    // "Search products, vendors and categories": match the product text, or its store, or its category.
    const [matchingVendors, matchingCategories] = await Promise.all([
      vendors.filter((v) => rx.test(v.businessName)).map((v) => v._id),
      Category.find({ name: rx }).select("_id"),
    ]);
    and.push({
      $or: [
        { name: rx },
        { description: rx },
        { vendorId: { $in: matchingVendors } },
        { categoryId: { $in: matchingCategories.map((c) => c._id) } },
      ],
    });
  }

  const filter = { $and: and };
  const [products, total] = await Promise.all([
    Product.find(filter)
      .sort(SORTS[f.sort])
      .skip((f.page - 1) * f.limit)
      .limit(f.limit),
    Product.countDocuments(filter),
  ]);
  return { items: await toCards(products), total };
}

/** Categories that get their own product row on the home page. */
const FEATURED_CATEGORIES = ["tubers-and-produce", "fashion"];
/** A row with fewer products than this is left out rather than shown half empty. */
const MIN_ROW_PRODUCTS = 3;

export async function homeData(city?: string) {
  const vendors = await visibleVendors({ city });
  const base = { vendorId: { $in: vendors.map((v) => v._id) }, isActive: true };
  const [categories, best, fresh] = await Promise.all([
    Category.find().sort({ sortOrder: 1 }),
    vendors.length ? Product.find(base).sort(SORTS.popular).limit(8) : [],
    vendors.length ? Product.find(base).sort(SORTS.newest).limit(6) : [],
  ]);

  // A row of products for the categories the home page features, and a few product photos per store for its tile.
  const featured = categories.filter((c) => FEATURED_CATEGORIES.includes(c.slug));
  const [rows, storeProducts] = await Promise.all([
    Promise.all(featured.map((c) => (vendors.length ? Product.find({ ...base, categoryId: c._id }).sort(SORTS.popular).limit(6) : []))),
    vendors.length ? Product.find(base).sort(SORTS.popular).limit(60) : [],
  ]);
  const storeCards = await toCards(storeProducts);
  const shownStores = vendors.slice(0, 6);
  const storeCities = await cityNames(shownStores);

  return {
    categories: categories.map(publicCategory),
    bestSellers: await toCards(best),
    newArrivals: await toCards(fresh),
    categoryRows: (
      await Promise.all(featured.map(async (c, i) => ({ category: { slug: c.slug, name: c.name }, products: await toCards(rows[i]!) })))
    ).filter((r) => r.products.length >= MIN_ROW_PRODUCTS),
    stores: shownStores.map((v) => ({
      ...publicVendor(v, storeCities.get(String(v._id))),
      photos: storeCards.filter((p) => p.vendor.slug === v.slug && p.image).slice(0, 3).map((p) => p.image as string),
    })),
  };
}

export async function productDetail(slug: string) {
  const product = await Product.findOne({ slug: slug.toLowerCase(), isActive: true });
  if (!product) return null;
  const [vendors, category] = await Promise.all([visibleVendors({}), Category.findById(product.categoryId)]);
  const vendor = vendors.find((v) => String(v._id) === String(product.vendorId));
  if (!vendor) return null; // vendor not approved, suspended, or city not live
  const cityName = (await cityNames([vendor])).get(String(vendor._id)) ?? null;
  return {
    ...presentCard(product, vendor, category ?? undefined),
    description: product.description,
    // A product with no photos still shows one stand-in picture (when placeholders are enabled).
    images: product.images.length ? product.images.map((i) => i.url) : [productPlaceholder(category?.slug)].filter((u): u is string => Boolean(u)),
    vendorDetail: {
      slug: vendor.slug,
      businessName: vendor.businessName,
      description: vendor.description ?? null,
      cityName,
    },
  };
}
