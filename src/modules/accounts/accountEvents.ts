import { User, type UserDoc } from "../../models/User.js";
import type { VendorDoc } from "../../models/Vendor.js";
import { getNotifier, type NotificationMessage, type NotifyOptions, type Recipient } from "../../services/notifications/index.js";
import { notifyDesks, notifyTeam } from "./team.js";

const toRecipient = (u: UserDoc): Recipient => ({ id: String(u._id), name: u.name, email: u.email });
const send = (to: UserDoc[], m: NotificationMessage, options?: NotifyOptions) => (to.length ? getNotifier().notify(to.map(toRecipient), m, options) : Promise.resolve());

/** A notification problem must never break the sign-up or the admin action that caused it. */
async function safely(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (err) {
    console.error("Account notification failed:", (err as Error).message);
  }
}

export const notifyWelcome = (user: UserDoc) =>
  safely(async () => {
    await send([user], {
      kind: "WELCOME",
      title: "Welcome to VendraMart",
      body: "Your account is ready. Shop from many Ibadan vendors in one cart and pay once. The delivery fee for each vendor is shown before you pay.",
      link: "/",
    }, { channels: "in-app" });
    await notifyDesks({ kind: "NEW_CUSTOMER", title: `New customer: ${user.name}`, body: `${user.name} (${user.email}, ${user.phone}) created a customer account.`, link: "/admin/customers/" });
  });

/** The store owner is told the application arrived, and the admins are told there is one to review. */
export const notifyVendorApplied = (owner: UserDoc, vendor: VendorDoc) =>
  safely(async () => {
    await send([owner], {
      kind: "VENDOR_APPLIED",
      title: "We received your store application",
      body: `${vendor.businessName} is waiting for approval. You can add your products now. They go live once an admin approves the store, and we will email you.`,
      link: "/vendor/",
    });
    await notifyTeam(
      "vendors",
      {
        kind: "VENDOR_PENDING",
        title: `New store to review: ${vendor.businessName}`,
        body: `${vendor.ownerName} (${owner.email}, ${owner.phone}) registered ${vendor.businessName}. Check the details and approve or decline.`,
        link: `/admin/vendors/?id=${vendor._id}`,
      },
      { vendorDesk: true },
    );
  });

export const notifyVendorDecision = (vendor: VendorDoc, decision: "APPROVED" | "SUSPENDED") =>
  safely(async () => {
    const owner = await User.findById(vendor.userId);
    if (!owner) return;
    await send([owner], {
      kind: decision === "APPROVED" ? "VENDOR_APPROVED" : "VENDOR_SUSPENDED",
      title: decision === "APPROVED" ? `${vendor.businessName} is live on VendraMart` : `${vendor.businessName} has been suspended`,
      body:
        decision === "APPROVED"
          ? "Your store is approved and customers can now see and buy your products."
          : `Your store is hidden and cannot take new orders. Reason: ${vendor.statusReason ?? "not given"}. Contact support if you think this is a mistake.`,
      link: decision === "APPROVED" ? "/vendor/products/" : "/vendor/",
    });
    await notifyDesks(
      {
        kind: decision === "APPROVED" ? "TEAM_VENDOR_APPROVED" : "TEAM_VENDOR_SUSPENDED",
        title: `${vendor.businessName} was ${decision === "APPROVED" ? "approved" : "suspended"}`,
        body: decision === "APPROVED" ? `${vendor.ownerName}'s store is now live.` : `Reason: ${vendor.statusReason ?? "not given"}.`,
        link: `/admin/vendors/?id=${vendor._id}`,
      },
      { vendorDesk: true },
    );
  });
