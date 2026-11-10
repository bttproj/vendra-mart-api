import type { Types } from "mongoose";
import { calculateDeliveryFee, formatTenthsKm, ratesForCity } from "../../domain/deliveryFee.js";
import { sumKobo } from "../../domain/money.js";
import { lineTotalKobo, splitByVendor, type CartLine } from "../../domain/orderSplit.js";
import { Address } from "../../models/Address.js";
import { City } from "../../models/City.js";
import { getPricing } from "../../models/Settings.js";
import { getDistanceProvider } from "../../services/distance/index.js";
import { AppError } from "../../utils/AppError.js";
import { resolveCart, type RequestedItem, type ResolvedLine } from "./cart.service.js";

type QuoteLine = CartLine & { name: string; image: string | null; slug: string };

/**
 * The server's own price for a basket delivered to one saved address. Nothing in the request is
 * trusted for money: prices come from the products, distances from the maps provider, and rates
 * from the admin settings. Phase 4 builds the order from exactly this result.
 */
export async function buildQuote(userId: Types.ObjectId, items: RequestedItem[], addressId: string) {
  if (items.length === 0) throw AppError.validation("Your cart is empty");

  const lines = await resolveCart(items);
  const problems = lines.filter((l) => l.status !== "OK");
  if (problems.length) {
    throw AppError.conflict("Some items in your cart have changed. Review your cart and try again.", problems.map(describeProblem));
  }

  // Delivery address: must be the signed-in customer's own, inside a city we operate in.
  const address = await Address.findOne({ _id: addressId, userId });
  if (!address) throw AppError.notFound("Address not found");
  const city = address.cityId ? await City.findById(address.cityId) : null;
  if (!city) throw AppError.validation("That address is outside the cities we serve yet. Choose a delivery address in Ibadan.");
  if (!city.isActive) throw AppError.validation(`${city.name} is coming soon. We only deliver in Ibadan for now.`);

  // One delivery leg per vendor; every vendor must pick up in the same city as the drop-off.
  const cartLines: QuoteLine[] = lines.map((l) => ({
    productId: l.productId,
    vendorId: l.product!.vendorId,
    qty: l.qty,
    unitPriceKobo: l.product!.priceKobo,
    name: l.product!.name,
    image: l.product!.image,
    slug: l.product!.slug,
  }));
  const groups = splitByVendor(cartLines);
  const vendorOf = (vendorId: string) => lines.find((l) => l.product!.vendorId === vendorId)!.vendorDoc!;

  const elsewhere = groups.map((g) => vendorOf(g.vendorId)).filter((v) => String(v.pickup!.cityId) !== String(city._id));
  if (elsewhere.length) {
    throw AppError.validation(`We cannot deliver across cities yet. ${elsewhere.map((v) => v.businessName).join(", ")} ships from another city than your address.`);
  }

  // The city's own fares where the admin set them, the platform's where not. Everything below, and the order's snapshot, uses these.
  const platform = await getPricing();
  const pricing = { ...platform, ...ratesForCity(platform, city) };
  const provider = getDistanceProvider();
  const dropoff = { lat: address.location!.lat, lng: address.location!.lng };

  const legs = await Promise.all(
    groups.map(async (group) => {
      const vendor = vendorOf(group.vendorId);
      const pickup = { lat: vendor.pickup!.lat, lng: vendor.pickup!.lng };
      const meters = await provider.driveDistanceMeters(pickup, dropoff);
      const fee = calculateDeliveryFee({ distanceMeters: meters, pricePerKmKobo: pricing.pricePerKmKobo, minFeeKobo: pricing.minDeliveryFeeKobo });
      return {
        vendor: { id: group.vendorId, slug: vendor.slug, businessName: vendor.businessName, pickupLine: vendor.pickup!.line },
        pickup: { line: vendor.pickup!.line, lat: pickup.lat, lng: pickup.lng },
        items: group.lines.map((l) => ({
          productId: l.productId,
          slug: l.slug,
          name: l.name,
          image: l.image,
          qty: l.qty,
          unitPriceKobo: l.unitPriceKobo,
          lineTotalKobo: lineTotalKobo(l),
        })),
        itemsTotalKobo: group.itemsTotalKobo,
        delivery: {
          distanceMeters: fee.billedMeters,
          distanceKm: formatTenthsKm(fee.distanceTenthsKm),
          pricePerKmKobo: fee.pricePerKmKobo,
          minFeeKobo: fee.minFeeKobo,
          minFeeApplied: fee.minFeeApplied,
          feeKobo: fee.feeKobo,
        },
      };
    }),
  );

  const itemsSubtotalKobo = sumKobo(legs.map((l) => l.itemsTotalKobo));
  const deliveryTotalKobo = sumKobo(legs.map((l) => l.delivery.feeKobo));
  const totalTenths = legs.reduce((t, l) => t + l.delivery.distanceMeters / 100, 0);

  return {
    address: {
      id: String(address._id),
      label: address.label,
      line: address.line,
      landmark: address.landmark ?? null,
      lat: dropoff.lat,
      lng: dropoff.lng,
      city: { id: String(city._id), name: city.name },
    },
    legs,
    itemsSubtotalKobo,
    deliveryTotalKobo,
    totalKobo: itemsSubtotalKobo + deliveryTotalKobo,
    totalDistanceKm: formatTenthsKm(totalTenths),
    // commissionBps is internal: order creation snapshots it, the shopper never sees it.
    pricing: { pricePerKmKobo: pricing.pricePerKmKobo, minDeliveryFeeKobo: pricing.minDeliveryFeeKobo, commissionBps: pricing.commissionBps },
  };
}

export type Quote = Awaited<ReturnType<typeof buildQuote>>;

/** What the browser may see: no commission rate, no vendor coordinates. */
export function publicQuote(q: Quote) {
  return {
    ...q,
    legs: q.legs.map(({ pickup: _pickup, ...leg }) => leg),
    pricing: { pricePerKmKobo: q.pricing.pricePerKmKobo, minDeliveryFeeKobo: q.pricing.minDeliveryFeeKobo },
  };
}

function describeProblem(l: ResolvedLine) {
  const message =
    l.status === "UNAVAILABLE"
      ? "No longer available"
      : l.status === "OUT_OF_STOCK"
        ? `${l.product!.name} is sold out`
        : `Only ${l.maxQty} of ${l.product!.name} left`;
  return { path: `items.${l.productId}`, message, status: l.status, maxQty: l.maxQty };
}
