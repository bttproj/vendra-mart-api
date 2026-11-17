import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";
import { objectId, pagination } from "../../utils/zodCommon.js";
import { Order, type OrderDoc } from "../../models/Order.js";
import { StatusLog } from "../../models/StatusLog.js";
import { SubOrder } from "../../models/SubOrder.js";
import { Vendor } from "../../models/Vendor.js";
import { expireIfStale } from "./orders.service.js";

// Customers only, and every query is scoped to the signed-in customer's own orders.
export const ordersRouter = Router();
ordersRouter.use(requireRole("CUSTOMER"));

const presentOrderBase = (o: OrderDoc) => ({
  id: String(o._id),
  orderNumber: o.orderNumber,
  status: o.status,
  totalKobo: o.totalKobo,
  itemsSubtotalKobo: o.itemsSubtotalKobo,
  deliveryTotalKobo: o.deliveryTotalKobo,
  createdAt: o.createdAt,
  expiresAt: o.expiresAt,
  paidAt: o.payment?.paidAt ?? null,
  needsAttention: o.needsAttention,
});

ordersRouter.get(
  "/",
  validate({ query: pagination }),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.validated.query;
    const filter = { customerId: req.user!._id };
    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Order.countDocuments(filter),
    ]);
    const fresh = await Promise.all(orders.map(expireIfStale));
    const subs = await SubOrder.find({ orderId: { $in: fresh.map((o) => o._id) } }).select("orderId status items.name items.qty");
    ok(
      res,
      fresh.map((o) => {
        const mine = subs.filter((s) => String(s.orderId) === String(o._id));
        const names = mine.flatMap((s) => s.items.map((i) => i.name));
        return {
          ...presentOrderBase(o),
          itemCount: mine.reduce((n, s) => n + s.items.reduce((m, i) => m + i.qty, 0), 0),
          itemNames: names.slice(0, 3),
          moreItems: names.length > 3, // true only when there are more distinct products than the names shown
          deliveries: mine.map((s) => s.status),
        };
      }),
      { page, limit, total },
    );
  }),
);

// Polled by the payment callback page. Declared before "/:id" so "payment-status" is not read as an id.
ordersRouter.get(
  "/payment-status",
  validate({ query: z.object({ reference: z.string().trim().min(3).max(100) }) }),
  asyncHandler(async (req, res) => {
    const found = await Order.findOne({ "payment.reference": req.validated.query.reference, customerId: req.user!._id });
    if (!found) throw AppError.notFound("Order not found");
    const order = await expireIfStale(found);
    ok(res, { orderId: String(order._id), orderNumber: order.orderNumber, status: order.status, totalKobo: order.totalKobo, needsAttention: order.needsAttention });
  }),
);

ordersRouter.get(
  "/:id",
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    const found = await Order.findOne({ _id: req.validated.params.id, customerId: req.user!._id });
    if (!found) throw AppError.notFound("Order not found");
    const order = await expireIfStale(found);

    const subs = await SubOrder.find({ orderId: order._id }).sort({ ref: 1 });
    const [vendors, logs] = await Promise.all([
      Vendor.find({ _id: { $in: subs.map((s) => s.vendorId) } }).select("businessName slug"),
      StatusLog.find({ subOrderId: { $in: subs.map((s) => s._id) } }).sort({ at: 1 }),
    ]);
    const vendorById = new Map(vendors.map((v) => [String(v._id), v]));

    ok(res, {
      ...presentOrderBase(order),
      address: { label: order.deliveryAddress!.label ?? null, line: order.deliveryAddress!.line, landmark: order.deliveryAddress!.landmark ?? null, cityName: order.deliveryAddress!.cityName ?? null },
      subOrders: subs.map((s) => ({
        id: String(s._id),
        ref: s.ref,
        status: s.status,
        vendor: { businessName: vendorById.get(String(s.vendorId))?.businessName ?? "Store", slug: vendorById.get(String(s.vendorId))?.slug ?? null },
        items: s.items.map((i) => ({ productId: String(i.productId), name: i.name, image: i.image ?? null, qty: i.qty, unitPriceKobo: i.unitPriceKobo, lineTotalKobo: i.lineTotalKobo })),
        itemsTotalKobo: s.itemsTotalKobo,
        // Commission and vendor earnings are not the customer's business.
        delivery: {
          distanceKm: (Math.round(s.delivery!.distanceMeters / 100) / 10).toFixed(1),
          pricePerKmKobo: s.delivery!.pricePerKmKobo,
          feeKobo: s.delivery!.feeKobo,
          minFeeApplied: s.delivery!.minFeeApplied,
        },
        deliveredAt: s.deliveredAt ?? null,
        failureReason: s.failureReason ?? null,
        timeline: logs.filter((l) => String(l.subOrderId) === String(s._id)).map((l) => ({ status: l.to, at: l.at, note: l.note ?? null })),
      })),
    });
  }),
);
