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

// Staff accounts are created by an administrator only. Staff means delivery handlers and other administrators. Customers
// and vendors can never be made here: the role comes from a short fixed list, not from whatever the request says.
export const adminStaffRouter = Router();

const STAFF_ROLES = ["HANDLER", "ADMIN"] as const;
const ACTIVE_DELIVERY = ["PAID", "READY_FOR_PICKUP", "PICKED_UP", "FAILED_DELIVERY"] as const;

const present = (u: UserDoc, viewerId: unknown, activeDeliveries?: number) => ({
  id: String(u._id),
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role,
  isActive: u.isActive,
  isYou: String(u._id) === String(viewerId),
  lastLoginAt: u.lastLoginAt ?? null,
  createdAt: u.createdAt,
  ...(activeDeliveries === undefined ? {} : { activeDeliveries }),
});

adminStaffRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    // Administrators first ("ADMIN" sorts before "HANDLER"), newest first within each.
    const staff = await User.find({ role: { $in: STAFF_ROLES } }).sort({ role: 1, createdAt: -1 });
    const loads = await Promise.all(staff.map((s) => (s.role === "HANDLER" ? SubOrder.countDocuments({ handlerId: s._id, status: { $in: ACTIVE_DELIVERY } }) : Promise.resolve(undefined))));
    ok(res, staff.map((s, i) => present(s, req.user!._id, loads[i])));
  }),
);

const createBody = z
  .object({
    name: z.string().trim().min(2, "Enter their full name").max(120),
    email,
    phone,
    password,
    role: z.enum(STAFF_ROLES).default("HANDLER"),
  })
  .strict();

/** What a new staff member is told. The password is never in the email: the admin gives it to them directly. */
const welcome = (role: (typeof STAFF_ROLES)[number]) =>
  role === "ADMIN"
    ? {
        kind: "STAFF_ACCOUNT",
        title: "Your VendraMart administrator account is ready",
        body: "A VendraMart administrator has created an administrator account for you. Sign in with this email address and the password they gave you.\n\nFor your own safety, choose a password only you know: on the sign-in page use \"Forgot your password?\" and follow the link we email you.\n\nAdministrators can manage stores, orders, payouts, customers and other staff.",
        link: "/login/",
        cta: "Sign in",
      }
    : {
        kind: "STAFF_ACCOUNT",
        title: "Your VendraMart delivery account is ready",
        body: "A VendraMart administrator has created a delivery handler account for you. Sign in with this email address and the password they gave you, and you will see the deliveries assigned to you.",
        link: "/login/",
        cta: "Sign in",
      };

adminStaffRouter.post(
  "/",
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const { name, email: addr, phone: tel, password: pw, role } = req.validated.body;
    if (await User.exists({ email: addr })) throw AppError.conflict("An account with this email already exists.");
    const user = await User.create({ role, name, email: addr, phone: tel, passwordHash: await hashPassword(pw), createdBy: req.user!._id });
    console.info(`Admin ${req.user!._id} created ${role.toLowerCase()} account ${user._id}`);

    const log = (what: string) => (err: unknown) => console.error(`Could not send the ${what}:`, (err as Error).message);
    void getNotifier()
      .notify([{ id: String(user._id), name: user.name, email: user.email }], welcome(role), { channels: "external" })
      .catch(log("staff account email"));

    // Every other administrator is told, so a new administrator can never appear without the team knowing.
    if (role === "ADMIN") {
      const others = await User.find({ role: "ADMIN", isActive: true, _id: { $nin: [req.user!._id, user._id] } });
      if (others.length) {
        void getNotifier()
          .notify(others.map((o) => ({ id: String(o._id), name: o.name, email: o.email })), {
            kind: "ADMIN_ADDED",
            title: "A new administrator was added",
            body: `${req.user!.name} added ${user.name} (${user.email}) as an administrator.\n\nIf you did not expect this, check the staff list and deactivate the account.`,
            link: "/admin/staff/",
            cta: "Open staff accounts",
          })
          .catch(log("new administrator notice"));
      }
    }
    created(res, present(user, req.user!._id, role === "HANDLER" ? 0 : undefined));
  }),
);

adminStaffRouter.patch(
  "/:id",
  validate({
    params: z.object({ id: objectId }),
    body: z.object({ isActive: z.boolean().optional(), name: z.string().trim().min(2).max(120).optional(), phone: phone.optional() }).strict(),
  }),
  asyncHandler(async (req, res) => {
    // Scoped to staff, so this cannot be used on a customer or a vendor, and it never changes anyone's role.
    const user = await User.findOne({ _id: req.validated.params.id, role: { $in: STAFF_ROLES } });
    if (!user) throw AppError.notFound("Staff account not found");
    if (req.validated.body.isActive === false && String(user._id) === String(req.user!._id)) {
      throw AppError.conflict("You cannot deactivate your own account. Ask another administrator to do it.");
    }
    Object.assign(user, req.validated.body);
    await user.save();
    ok(res, present(user, req.user!._id));
  }),
);
