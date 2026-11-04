import { env, isTest } from "../../config/env.js";
import { hasAnyPermission, type Permission } from "../../domain/permissions.js";
import { User, type UserDoc } from "../../models/User.js";
import { getNotifier, type NotificationMessage, type Recipient } from "../../services/notifications/index.js";

// Who in the back office hears about what happened. Two kinds of people:
//   - staff accounts: a super admin hears everything, a staff member hears the areas they were given (bell and email);
//   - the shared mailboxes (admin@ gets every activity, vendors@ also gets the vendor and sales ones), by email only.

export const toRecipient = (u: UserDoc): Recipient => ({ id: String(u._id), name: u.name, email: u.email });

const DEFAULTS = { admin: "admin@vendramart.com", vendors: "vendors@vendramart.com" } as const;
export type Desk = keyof typeof DEFAULTS;

// Tests choose the mailboxes themselves, so a developer's own .env can never change what a test sees.
let testDesks: Partial<Record<Desk, string>> = {};
export const setDeskAddressesForTests = (desks: Partial<Record<Desk, string>>) => {
  testDesks = desks;
};

/** The mailbox for a desk. Set ADMIN_NOTIFY_EMAIL or VENDOR_NOTIFY_EMAIL to change it, or to "off" to stop those emails. */
export function deskAddress(desk: Desk): string | null {
  const set = isTest ? testDesks[desk] : desk === "admin" ? env.ADMIN_NOTIFY_EMAIL : env.VENDOR_NOTIFY_EMAIL;
  const value = (set ?? (isTest ? "" : DEFAULTS[desk])).trim().toLowerCase();
  return value && value !== "off" && value !== "none" ? value : null;
}

const noTitle = [{ staffTitle: { $exists: false } }, { staffTitle: null }];

/** Active administrators with no staff title. */
export const superAdmins = (): Promise<UserDoc[]> => User.find({ role: "ADMIN", isActive: true, $or: noTitle });

/** Active super admins, plus staff who were given at least one of these areas. */
export async function staffWith(permissions: Permission | readonly Permission[]): Promise<UserDoc[]> {
  const wanted = Array.isArray(permissions) ? permissions : [permissions as Permission];
  const admins = await User.find({ role: "ADMIN", isActive: true });
  return admins.filter((u) => hasAnyPermission(u, wanted));
}

/**
 * Tells the staff who handle this area (bell and email) and the shared mailboxes (email). `vendorDesk` is for anything about
 * stores or sales, which vendors@ also receives. Never throws: a mail problem must not break the action that caused it.
 */
export async function notifyTeam(permissions: Permission | readonly Permission[], message: NotificationMessage, opts: { vendorDesk?: boolean } = {}) {
  try {
    const staff = await staffWith(permissions);
    if (staff.length) await getNotifier().notify(staff.map(toRecipient), message);
    await notifyDesks(message, opts, staff);
  } catch (err) {
    console.error("Team notification failed:", (err as Error).message);
  }
}

/** The shared mailboxes only, for routine activity nobody has to act on. */
export async function notifyDesks(message: NotificationMessage, opts: { vendorDesk?: boolean } = {}, alreadyTold: UserDoc[] = []) {
  try {
    const told = new Set(alreadyTold.map((u) => u.email.toLowerCase()));
    const addresses = new Set<string>();
    for (const desk of ["admin", ...(opts.vendorDesk ? (["vendors"] as const) : [])] as Desk[]) {
      const a = deskAddress(desk);
      if (a && !told.has(a)) addresses.add(a);
    }
    if (!addresses.size) return;
    await getNotifier().notify([...addresses].map((email) => ({ id: `desk:${email}`, name: "VendraMart team", email })), message, { channels: "external" });
  } catch (err) {
    console.error("Team notification failed:", (err as Error).message);
  }
}
