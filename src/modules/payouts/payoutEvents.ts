import { User, type UserDoc } from "../../models/User.js";
import type { PayoutDoc } from "../../models/Payout.js";
import type { VendorDoc } from "../../models/Vendor.js";
import { getNotifier, type NotificationMessage, type Recipient } from "../../services/notifications/index.js";
import { formatNaira } from "../../utils/formatNaira.js";
import { adminPayoutPage } from "../../utils/webLinks.js";
import { notifyDesks, notifyTeam } from "../accounts/team.js";

const toRecipient = (u: UserDoc): Recipient => ({ id: String(u._id), name: u.name, email: u.email });
const send = (to: UserDoc[], m: NotificationMessage) => (to.length ? getNotifier().notify(to.map(toRecipient), m) : Promise.resolve());

/** A notification problem must never break the money action that caused it. */
async function safely(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (err) {
    console.error("Payout notification failed:", (err as Error).message);
  }
}

export const notifyPayoutRequested = (payout: PayoutDoc, vendor: VendorDoc) =>
  safely(async () =>
    notifyTeam(
      "payouts",
      {
        kind: "PAYOUT_REQUESTED",
        title: `Payout request ${payout.number}`,
        body: `${vendor.businessName} asked for ${formatNaira(payout.amountKobo)} across ${payout.subOrderIds.length} ${payout.subOrderIds.length === 1 ? "order" : "orders"}.`,
        link: adminPayoutPage(payout._id),
      },
      { vendorDesk: true },
    ),
  );

export const notifyPayoutPaid = (payout: PayoutDoc, vendor: VendorDoc) =>
  safely(async () => {
    const owner = await User.findById(vendor.userId);
    if (owner) {
      await send([owner], {
        kind: "PAYOUT_PAID",
        title: `Payout ${payout.number} paid`,
        body: `${formatNaira(payout.amountKobo)} has been transferred to ${payout.bank!.bankName}. The transfer receipt is on your earnings page.`,
        link: "/vendor/earnings",
      });
    }
    await notifyDesks({ kind: "TEAM_PAYOUT_PAID", title: `Payout ${payout.number} paid`, body: `${formatNaira(payout.amountKobo)} was transferred to ${vendor.businessName}.`, link: adminPayoutPage(payout._id) }, { vendorDesk: true });
  });

export const notifyPayoutDeclined = (payout: PayoutDoc, vendor: VendorDoc) =>
  safely(async () => {
    const owner = await User.findById(vendor.userId);
    if (owner) {
      await send([owner], {
        kind: "PAYOUT_DECLINED",
        title: `Payout ${payout.number} declined`,
        body: `Reason: ${payout.declineReason}. The ${formatNaira(payout.amountKobo)} is back in your available balance.`,
        link: "/vendor/earnings",
      });
    }
    await notifyDesks({ kind: "TEAM_PAYOUT_DECLINED", title: `Payout ${payout.number} declined`, body: `${vendor.businessName}: ${payout.declineReason}.`, link: adminPayoutPage(payout._id) }, { vendorDesk: true });
  });
