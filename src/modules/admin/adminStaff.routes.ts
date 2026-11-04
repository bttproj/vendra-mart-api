import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { created, ok } from "../../utils/respond.js";
import { email, objectId, password, phone } from "../../utils/zodCommon.js";
import { cleanPermissions, isSuperAdmin, PERMISSIONS, PERMISSION_LABELS, STAFF_TITLE_INFO, STAFF_TITLES, type StaffTitle } from "../../domain/permissions.js";
import { SubOrder } from "../../models/SubOrder.js";
import { User, type Role, type UserDoc } from "../../models/User.js";
import { getNotifier } from "../../services/notifications/index.js";
import { superAdmins, toRecipient } from "../accounts/team.js";
import { hashPassword } from "../auth/auth.service.js";

// Back-office accounts. Only a super admin creates other administrators and staff (operations manager, finance manager...)
// and chooses what they can open. A staff member who was given "Delivery handlers" may create and switch off delivery
// handlers, and nothing else here. Customers and vendors can never be made here: the role comes from a short fixed list.
export const adminStaffRouter = Router();
adminStaffRouter.use(requirePermission("handlers"));

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
  ...(u.role === "ADMIN"
    ? {
        isSuperAdmin: !u.staffTitle,
        staffTitle: u.staffTitle ?? null,
        staffLabel: u.staffTitle ? STAFF_TITLE_INFO[u.staffTitle as StaffTitle].label : "Super admin",
        permissions: u.staffTitle ? cleanPermissions(u.permissions ?? []) : [...PERMISSIONS],
      }
    : {}),
  ...(activeDeliveries === undefined ? {} : { activeDeliveries }),
});

/** Who the signed-in person may see and change: a super admin all staff, a manager delivery handlers only. */
const scopeFor = (viewer: UserDoc): { role: { $in: Role[] } } => ({ role: { $in: isSuperAdmin(viewer) ? ["HANDLER", "ADMIN"] : ["HANDLER"] } });

adminStaffRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    // Administrators first ("ADMIN" sorts before "HANDLER"), newest first within each.
    const staff = await User.find(scopeFor(req.user!)).sort({ role: 1, createdAt: -1 });
    const loads = await Promise.all(staff.map((s) => (s.role === "HANDLER" ? SubOrder.countDocuments({ handlerId: s._id, status: { $in: ACTIVE_DELIVERY } }) : Promise.resolve(undefined))));
    ok(res, staff.map((s, i) => present(s, req.user!._id, loads[i])));
  }),
);

const permissionList = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);

const createBody = z
  .object({
    name: z.string().trim().min(2, "Enter their full name").max(120),
    email,
    phone,
    password,
    // STAFF is an administrator account with a title and a list of areas (an operations manager, say).
    role: z.enum(["HANDLER", "ADMIN", "STAFF"]).default("HANDLER"),
    staffTitle: z.enum(STAFF_TITLES).optional(),
    permissions: permissionList.optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.role === "STAFF" && !b.staffTitle) ctx.addIssue({ code: "custom", path: ["staffTitle"], message: "Choose their job title" });
    if (b.role !== "STAFF" && (b.staffTitle || b.permissions)) ctx.addIssue({ code: "custom", path: ["staffTitle"], message: "A title and permissions are only for staff accounts" });
  });

const areaWords = (permissions: string[]) => permissions.map((p) => PERMISSION_LABELS[p as keyof typeof PERMISSION_LABELS]?.label).filter(Boolean).join(", ");

/** What a new staff member is told. The password is never in the email: the admin gives it to them directly. */
function welcome(role: "HANDLER" | "ADMIN" | "STAFF", title?: StaffTitle, permissions: string[] = []) {
  const forgot = "For your own safety, choose a password only you know: on the sign-in page use \"Forgot your password?\" and follow the link we email you.";
  if (role === "STAFF") {
    const label = STAFF_TITLE_INFO[title!].label;
    return {
      kind: "STAFF_ACCOUNT",
      title: `Your VendraMart ${label.toLowerCase()} account is ready`,
      body: `A VendraMart administrator has created a ${label.toLowerCase()} account for you. Sign in with this email address and the password they gave you.\n\n${forgot}\n\nYou can open: ${areaWords(permissions) || "nothing yet (ask the administrator)"}.`,
      link: "/login/",
      cta: "Sign in",
    };
  }
  if (role === "ADMIN") {
    return {
      kind: "STAFF_ACCOUNT",
      title: "Your VendraMart administrator account is ready",
      body: `A VendraMart administrator has created an administrator account for you. Sign in with this email address and the password they gave you.\n\n${forgot}\n\nAdministrators can manage stores, orders, payouts, customers and other staff.`,
      link: "/login/",
      cta: "Sign in",
    };
  }
  return {
    kind: "STAFF_ACCOUNT",
    title: "Your VendraMart delivery account is ready",
    body: "A VendraMart team member has created a delivery handler account for you. Sign in with this email address and the password they gave you, and you will see the deliveries assigned to you.",
    link: "/login/",
    cta: "Sign in",
  };
}

adminStaffRouter.post(
  "/",
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const { name, email: addr, phone: tel, password: pw, role } = req.validated.body;
    const staffTitle = req.validated.body.staffTitle as StaffTitle | undefined;
    // Managers may create delivery handlers only. Anything with more access than that is for a super admin.
    if (role !== "HANDLER" && !isSuperAdmin(req.user!)) throw AppError.forbidden("Only a super admin can create administrator and staff accounts.");
    if (await User.exists({ email: addr })) throw AppError.conflict("An account with this email already exists.");

    const permissions = role === "STAFF" ? cleanPermissions(req.validated.body.permissions ?? STAFF_TITLE_INFO[staffTitle!].defaults) : undefined;
    const user = await User.create({
      role: role === "HANDLER" ? "HANDLER" : "ADMIN",
      name,
      email: addr,
      phone: tel,
      passwordHash: await hashPassword(pw),
      createdBy: req.user!._id,
      ...(role === "STAFF" ? { staffTitle, permissions } : {}),
    });
    console.info(`${req.user!.role} ${req.user!._id} created ${role.toLowerCase()} account ${user._id}`);

    const log = (what: string) => (err: unknown) => console.error(`Could not send the ${what}:`, (err as Error).message);
    void getNotifier()
      .notify([{ id: String(user._id), name: user.name, email: user.email }], welcome(role, staffTitle, permissions), { channels: "external" })
      .catch(log("staff account email"));

    // Every other super admin is told, so a new administrator or manager can never appear without the team knowing.
    if (role !== "HANDLER") {
      const others = (await superAdmins()).filter((o) => ![String(req.user!._id), String(user._id)].includes(String(o._id)));
      if (others.length) {
        const what = role === "STAFF" ? `a ${STAFF_TITLE_INFO[staffTitle!].label.toLowerCase()}` : "an administrator";
        void getNotifier()
          .notify(others.map(toRecipient), {
            kind: "ADMIN_ADDED",
            title: role === "STAFF" ? "A new staff member was added" : "A new administrator was added",
            body: `${req.user!.name} added ${user.name} (${user.email}) as ${what}.\n\nIf you did not expect this, check the staff list and deactivate the account.`,
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
    body: z
      .object({
        isActive: z.boolean().optional(),
        name: z.string().trim().min(2).max(120).optional(),
        phone: phone.optional(),
        // Super admin only: change a staff member's title or what they can open.
        staffTitle: z.enum(STAFF_TITLES).optional(),
        permissions: permissionList.optional(),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    // Scoped to what the viewer manages, so this cannot be used on a customer or a vendor, and it never changes anyone's role.
    const user = await User.findOne({ _id: req.validated.params.id, ...scopeFor(req.user!) });
    if (!user) throw AppError.notFound("Staff account not found");
    const { staffTitle, permissions, ...plain } = req.validated.body;

    if (staffTitle !== undefined || permissions !== undefined) {
      if (!isSuperAdmin(req.user!)) throw AppError.forbidden("Only a super admin can change what a staff member can open.");
      if (!user.staffTitle) throw AppError.conflict(user.role === "ADMIN" ? "A super admin always has full access." : "Delivery handlers have no dashboard permissions.");
      if (staffTitle !== undefined) user.staffTitle = staffTitle;
      if (permissions !== undefined) user.permissions = cleanPermissions(permissions);
    }
    if (plain.isActive === false && String(user._id) === String(req.user!._id)) {
      throw AppError.conflict("You cannot deactivate your own account. Ask another administrator to do it.");
    }
    Object.assign(user, plain);
    await user.save();
    ok(res, present(user, req.user!._id));
  }),
);
