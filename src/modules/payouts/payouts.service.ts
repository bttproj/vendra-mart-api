import { Types } from "mongoose";
import { assertPayoutTransition, PayoutTransitionError } from "../../domain/payoutStateMachine.js";
import { sumKobo } from "../../domain/money.js";
import { nextSeq } from "../../models/Counter.js";
import { Payout, type PayoutDoc } from "../../models/Payout.js";
import { SubOrder } from "../../models/SubOrder.js";
import { Vendor, type VendorDoc } from "../../models/Vendor.js";
import type { UserDoc } from "../../models/User.js";
import { getPrivateStorage } from "../../services/storage/index.js";
import { AppError } from "../../utils/AppError.js";
import { classifyDocument } from "../../utils/fileType.js";
import { storageFolder } from "../../utils/storagePaths.js";
import { availableFilter, declinedPayoutIds } from "../earnings/earnings.service.js";
import { notifyPayoutDeclined, notifyPayoutPaid, notifyPayoutRequested } from "./payoutEvents.js";

const PAYOUT_NUMBER_START = 2290; // first payout is PR-2291
const LOCK_MS = 30_000;

/**
 * Take the vendor's payout lock, or fail. The lock expires on its own (LOCK_MS), so a crash cannot leave a
 * vendor stuck. Without it, a double click could split the available orders between two partial payouts.
 */
async function acquireLock(vendorId: Types.ObjectId, now: Date): Promise<void> {
  const got = await Vendor.findOneAndUpdate(
    { _id: vendorId, $or: [{ payoutLockUntil: null }, { payoutLockUntil: { $lt: now } }] },
    { $set: { payoutLockUntil: new Date(now.getTime() + LOCK_MS) } },
  );
  if (!got) throw AppError.conflict("Your payout request is already being processed. Check your payout history in a moment.");
}
const releaseLock = (vendorId: Types.ObjectId) => Vendor.updateOne({ _id: vendorId }, { $unset: { payoutLockUntil: 1 } });

/**
 * A crash after orders were locked but before the payout was created would leave them locked to a payout that does
 * not exist. Free those, so the money can never be stuck (it cannot be paid twice either, because no payout exists).
 */
async function releaseOrphanLocks(vendorId: Types.ObjectId): Promise<void> {
  const locked = await SubOrder.distinct("payoutId", { vendorId, payoutId: { $ne: null } });
  if (locked.length === 0) return;
  const existing = new Set((await Payout.find({ _id: { $in: locked } }).select("_id")).map((p) => String(p._id)));
  const orphans = locked.filter((id) => !existing.has(String(id)));
  if (orphans.length) await SubOrder.updateMany({ vendorId, payoutId: { $in: orphans } }, { $unset: { payoutId: 1, payoutLockedAt: 1 } });
}

/**
 * The vendor asks for everything that is available right now. In one go it: locks the vendor, claims every
 * unlocked, delivered, hold-cleared sub-order for this payout with a single atomic update, adds up what it
 * actually claimed, and creates the payout. Held, undelivered and already-requested orders are never included.
 */
export async function requestPayout(vendor: VendorDoc, user: UserDoc, now = new Date()): Promise<PayoutDoc> {
  await acquireLock(vendor._id, now);
  try {
    await releaseOrphanLocks(vendor._id);
    const payoutId = new Types.ObjectId();
    const claim = await SubOrder.updateMany(availableFilter(vendor._id, now, await declinedPayoutIds(vendor._id)), { $set: { payoutId, payoutLockedAt: now } });
    if (claim.modifiedCount === 0) throw AppError.conflict("You have no earnings available to withdraw yet. Earnings unlock 4 working days after delivery.");

    try {
      const claimed = await SubOrder.find({ payoutId });
      const payout = await Payout.create({
        _id: payoutId,
        number: `PR-${await nextSeq("payout", PAYOUT_NUMBER_START)}`,
        vendorId: vendor._id,
        requestedBy: user._id,
        amountKobo: sumKobo(claimed.map((s) => s.vendorEarningKobo)),
        subOrderIds: claimed.map((s) => s._id),
        bank: { bankName: vendor.bank!.bankName, accountNumber: vendor.bank!.accountNumber, accountName: vendor.bank!.accountName },
        requestedAt: now,
      });
      await notifyPayoutRequested(payout, vendor);
      return payout;
    } catch (err) {
      // Could not create the payout: hand the orders back so nothing is stranded.
      await SubOrder.updateMany({ payoutId }, { $unset: { payoutId: 1, payoutLockedAt: 1 } });
      throw err;
    }
  } finally {
    await releaseLock(vendor._id);
  }
}

export interface ReceiptFile {
  buffer: Buffer;
}

/** Sniffs the real file type; the name and browser-sent type are not trusted. Receipts may be an image or a PDF. */
export const classifyReceipt = classifyDocument;

function mapTransitionError(err: unknown): never {
  if (err instanceof PayoutTransitionError) throw AppError.conflict("This payout request has already been decided.");
  throw err;
}

/** Marks a payout paid. The receipt is required and is stored privately before the status changes. */
export async function payPayout(payoutId: string, admin: UserDoc, receipt: ReceiptFile, now = new Date()): Promise<PayoutDoc> {
  const kind = classifyReceipt(receipt.buffer);
  if (!kind) throw AppError.validation("Upload the transfer receipt as an image (JPG, PNG, WebP) or a PDF", [{ path: "file", message: "Receipt must be an image or PDF" }]);

  const current = await Payout.findById(payoutId);
  if (!current) throw AppError.notFound("Payout not found");
  try {
    assertPayoutTransition(current.status, "PAID");
  } catch (err) {
    mapTransitionError(err);
  }

  const storage = getPrivateStorage();
  const stored = await storage.put(receipt.buffer, { folder: storageFolder("payouts", payoutId), mime: kind.mime, ext: kind.ext });

  // Guarded on status: if another admin decided it in the meantime, this loses and the upload is removed.
  const paid = await Payout.findOneAndUpdate(
    { _id: payoutId, status: "REQUESTED" },
    { $set: { status: "PAID", resolvedAt: now, resolvedBy: admin._id, receipt: { publicId: stored.publicId, mime: kind.mime, resourceType: stored.resourceType } } },
    { returnDocument: "after" },
  );
  if (!paid) {
    await storage.remove(stored.publicId, stored.resourceType).catch(() => {});
    throw AppError.conflict("This payout request has already been decided.");
  }

  const vendor = await Vendor.findById(paid.vendorId);
  if (vendor) await notifyPayoutPaid(paid, vendor);
  return paid;
}

/** Declines a payout with a reason. Its orders return to Available so the vendor can request again. */
export async function declinePayout(payoutId: string, admin: UserDoc, reason: string, now = new Date()): Promise<PayoutDoc> {
  const current = await Payout.findById(payoutId);
  if (!current) throw AppError.notFound("Payout not found");
  try {
    assertPayoutTransition(current.status, "DECLINED");
  } catch (err) {
    mapTransitionError(err);
  }

  const declined = await Payout.findOneAndUpdate(
    { _id: payoutId, status: "REQUESTED" },
    { $set: { status: "DECLINED", resolvedAt: now, resolvedBy: admin._id, declineReason: reason } },
    { returnDocument: "after" },
  );
  if (!declined) throw AppError.conflict("This payout request has already been decided.");

  // Release the locked orders. Earnings views and new requests also treat a declined payout's orders as free
  // (see availableFilter / earningState), so even if this step were interrupted nothing would stay stuck.
  await SubOrder.updateMany({ payoutId: declined._id }, { $unset: { payoutId: 1, payoutLockedAt: 1 } });

  const vendor = await Vendor.findById(declined.vendorId);
  if (vendor) await notifyPayoutDeclined(declined, vendor);
  return declined;
}
