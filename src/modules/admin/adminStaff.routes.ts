import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { created, ok } from "../../utils/respond.js";
import { email, objectId, password, phone } from "../../utils/zodCommon.js";
import { SubOrder } from "../../models/SubOrder.js";
import { User, type UserDoc } from "../../models/User.js";
import { getNotifier } from "../../services/notifications/index.js";
import { hashPassword } from "../auth/auth.service.js";

// Staff accounts are created by the Super Admin only. Today staff means Delivery Handlers.
export const adminStaffRouter = Router();

const present = (u: UserDoc, activeDeliveries?: number) => ({
  id: String(u._id),
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role,
  isActive: u.isActive,
  lastLoginAt: u.lastLoginAt ?? null,
  createdAt: u.createdAt,
  ...(activeDeliveries === undefined ? {} : { activeDeliveries }),
});

adminStaffRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const handlers = await User.find({ role: "HANDLER" }).sort({ createdAt: -1 });
    const loads = await Promise.all(handlers.map((h) => SubOrder.countDocuments({ handlerId: h._id, status: { $in: ["PAID", "READY_FOR_PICKUP", "PICKED_UP", "FAILED_DELIVERY"] } })));
    ok(res, handlers.map((h, i) => present(h, loads[i])));
  }),
);

adminStaffRouter.post(
  "/",
  validate({ body: z.object({ name: z.string().trim().min(2, "Enter their full name").max(120), email, phone, password }).strict() }),
  asyncHandler(async (req, res) => {
    const { name, email: addr, phone: tel, password: pw } = req.validated.body;
    if (await User.exists({ email: addr })) throw AppError.conflict("An account with this email already exists.");
    // The role is fixed here, never taken from the request: this endpoint can only ever make handlers.
    const user = await User.create({ role: "HANDLER", name, email: addr, phone: tel, passwordHash: await hashPassword(pw), createdBy: req.user!._id });
    // Tell them the account exists. The password is not in the email: the admin gives it to them directly.
    void getNotifier()
      .notify(
        [{ id: String(user._id), name: user.name, email: user.email }],
        {
          kind: "STAFF_ACCOUNT",
          title: "Your VendraMart delivery account is ready",
          body: "A VendraMart administrator has created a delivery handler account for you. Sign in with this email address and the password they gave you, and you will see the deliveries assigned to you.",
          link: "/login/",
          cta: "Sign in",
        },
        { channels: "external" },
      )
      .catch((err) => console.error("Could not send the staff account email:", (err as Error).message));
    created(res, present(user, 0));
  }),
);

adminStaffRouter.patch(
  "/:id",
  validate({
    params: z.object({ id: objectId }),
    body: z.object({ isActive: z.boolean().optional(), name: z.string().trim().min(2).max(120).optional(), phone: phone.optional() }).strict(),
  }),
  asyncHandler(async (req, res) => {
    // Scoped to handlers, so this cannot be used to deactivate an admin or a customer.
    const user = await User.findOne({ _id: req.validated.params.id, role: "HANDLER" });
    if (!user) throw AppError.notFound("Staff account not found");
    Object.assign(user, req.validated.body);
    await user.save();
    ok(res, present(user));
  }),
);
