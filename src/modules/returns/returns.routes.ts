import { Router } from "express";
import { z } from "zod";
import { RETURN_REASONS, RETURN_TYPES } from "../../domain/returns.js";
import { requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { created, ok } from "../../utils/respond.js";
import { objectId, pagination } from "../../utils/zodCommon.js";
import { ReturnRequest } from "../../models/ReturnRequest.js";
import { cancelReturn, lodgeReturn } from "./returns.service.js";
import { presentReturn } from "./returns.present.js";

// Customers only, and every query is scoped to the signed-in customer. A customer lodges a return or reports a problem on a
// delivery that has arrived, within 48 hours; an admin decides (see adminReturns.routes.ts).
export const returnsRouter = Router();
returnsRouter.use(requireRole("CUSTOMER"));

const lodgeBody = z
  .object({
    subOrderId: objectId,
    type: z.enum(RETURN_TYPES),
    reason: z.enum(RETURN_REASONS),
    description: z.string().trim().min(10, "Tell us what is wrong, in at least 10 characters").max(1000, "Keep it to 1000 characters"),
    items: z
      .array(z.object({ productId: objectId, qty: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(999) }).strict())
      .min(1, "Pick at least one item")
      .max(50),
  })
  .strict();

returnsRouter.post(
  "/",
  validate({ body: lodgeBody }),
  asyncHandler(async (req, res) => created(res, presentReturn(await lodgeReturn(req.user!, req.validated.body)))),
);

returnsRouter.get(
  "/",
  validate({ query: pagination }),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.validated.query;
    const filter = { customerId: req.user!._id };
    const [items, total] = await Promise.all([
      ReturnRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      ReturnRequest.countDocuments(filter),
    ]);
    ok(res, items.map((r) => presentReturn(r)), { page, limit, total });
  }),
);

returnsRouter.post(
  "/:id/cancel",
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => ok(res, presentReturn(await cancelReturn(req.user!._id, req.validated.params.id)))),
);
