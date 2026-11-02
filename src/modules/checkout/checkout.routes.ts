import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../middleware/auth.js";
import { paymentLimiter, quoteLimiter } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { created, ok } from "../../utils/respond.js";
import { AppError } from "../../utils/AppError.js";
import { objectId } from "../../utils/zodCommon.js";
import { presentLine, resolveCart } from "./cart.service.js";
import { buildQuote, publicQuote } from "./checkout.service.js";
import { createOrder } from "../orders/orders.service.js";

// strict(): a client that sends its own price or fee is rejected outright rather than silently ignored.
const item = z.object({ productId: objectId, qty: z.number().int().min(1).max(99) }).strict();
const itemsSchema = z.array(item).max(50, "Too many different items in one order");

/** Public: lets the cart page re-price and re-check stock. Reads only, never trusts client prices. */
export const cartRouter = Router();
cartRouter.post(
  "/validate",
  validate({ body: z.object({ items: itemsSchema }).strict() }),
  asyncHandler(async (req, res) => {
    const lines = await resolveCart(req.validated.body.items);
    ok(res, { lines: lines.map(presentLine) });
  }),
);

/** Customers only. */
export const checkoutRouter = Router();
checkoutRouter.use(requireRole("CUSTOMER"));

checkoutRouter.post(
  "/quote",
  quoteLimiter,
  validate({ body: z.object({ items: itemsSchema, addressId: objectId }).strict() }),
  asyncHandler(async (req, res) => {
    const { items, addressId } = req.validated.body;
    ok(res, publicQuote(await buildQuote(req.user!._id, items, addressId)));
  }),
);

/** Places the order: re-prices on the server, holds the stock, and starts the Paystack payment. */
checkoutRouter.post(
  "/",
  paymentLimiter,
  validate({ body: z.object({ items: itemsSchema, addressId: objectId }).strict() }),
  asyncHandler(async (req, res) => {
    const { items, addressId } = req.validated.body;
    if (!req.user!.emailVerified) {
      throw new AppError(403, "EMAIL_NOT_VERIFIED", "Please confirm your email address before placing an order. We sent you a link when you signed up, and you can ask for another one from the banner at the top of the page.");
    }
    const { order, authorizationUrl } = await createOrder(req.user!, items, addressId);
    created(res, {
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      reference: order.payment!.reference,
      totalKobo: order.totalKobo,
      expiresAt: order.expiresAt,
      authorizationUrl,
    });
  }),
);
