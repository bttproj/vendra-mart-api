import { Router } from "express";
import { z } from "zod";
import { adminMessageLimiter } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { created, ok } from "../../utils/respond.js";
import { objectId } from "../../utils/zodCommon.js";
import { presentVendorMessage } from "../../models/VendorMessage.js";
import { listVendorMessages, sendVendorMessage } from "./vendorMessages.service.js";

// Mounted under /api/admin/vendors, so the ADMIN role check has already run. One store at a time, on purpose.
export const adminVendorMessagesRouter = Router();

const messageBody = z
  .object({
    // No line breaks in the subject: it becomes an email header.
    subject: z
      .string()
      .trim()
      .min(3, "Write a subject of at least 3 characters")
      .max(120, "Keep the subject under 120 characters")
      .refine((v) => !/[\r\n]/.test(v), "The subject must be a single line"),
    body: z.string().trim().min(10, "Write a message of at least 10 characters").max(5000, "Keep the message under 5000 characters"),
  })
  .strict();

adminVendorMessagesRouter.post(
  "/:id/message",
  adminMessageLimiter,
  validate({ params: z.object({ id: objectId }), body: messageBody }),
  asyncHandler(async (req, res) => {
    const saved = await sendVendorMessage(req.validated.params.id, req.user!, req.validated.body);
    created(res, presentVendorMessage(saved));
  }),
);

adminVendorMessagesRouter.get(
  "/:id/messages",
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => ok(res, await listVendorMessages(req.validated.params.id))),
);
