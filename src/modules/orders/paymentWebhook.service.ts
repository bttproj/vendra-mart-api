import { Order, type OrderDoc } from "../../models/Order.js";
import { Product } from "../../models/Product.js";
import { StatusLog } from "../../models/StatusLog.js";
import { SubOrder, type SubOrderDoc } from "../../models/SubOrder.js";
import { WebhookEvent } from "../../models/WebhookEvent.js";
import { getPaymentGateway, getWebhookSecret } from "../../services/payments/index.js";
import { autoAssign } from "./autoAssign.js";
import { notifyOrderPaid } from "./orderEvents.js";
import { isValidSignature } from "../../services/payments/signature.js";

export type WebhookOutcome =
  | "PAID" // this call marked the order paid
  | "ALREADY_PAID" // someone (an earlier or concurrent call) already did
  | "DUPLICATE" // this exact event was fully processed before
  | "UNKNOWN_REFERENCE"
  | "NOT_SUCCESSFUL" // the provider says the payment did not succeed
  | "AMOUNT_MISMATCH" // paid amount or currency differs from the order total: needs a human
  | "LATE_PAYMENT"; // money arrived after the order was cancelled or expired: needs a human

export interface WebhookResponse {
  status: number;
  body: unknown;
}

const reply = (status: number, body: unknown): WebhookResponse => ({ status, body });
const fail = (status: number, code: string, message: string) => reply(status, { success: false, error: { code, message } });

/**
 * Handles one Paystack webhook delivery. An order is only ever marked paid after ALL of these:
 *   1. the body's HMAC-SHA512 signature matches our secret key (authentic),
 *   2. we ask Paystack directly about the reference (we do not trust the payload's claim),
 *   3. status is success, currency is NGN and the amount equals the order total to the kobo,
 *   4. a guarded update moves the order PENDING_PAYMENT -> PAID (so it can only happen once).
 * Safe to receive any number of times: Paystack retries and duplicates are no-ops.
 */
export async function handlePaystackWebhook(rawBody: Buffer, signature: string | undefined): Promise<WebhookResponse> {
  if (!isValidSignature(rawBody, signature, getWebhookSecret())) return fail(401, "UNAUTHENTICATED", "Invalid signature");

  let event: { event?: unknown; data?: { reference?: unknown } };
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return fail(400, "BAD_REQUEST", "Malformed JSON body");
  }

  // We only act on successful charges. Acknowledge everything else so Paystack stops retrying.
  if (event.event !== "charge.success") return reply(200, { success: true, data: { ignored: true } });
  const reference = event.data?.reference;
  if (typeof reference !== "string" || !reference) return fail(400, "BAD_REQUEST", "Missing reference");

  const outcome = await processChargeSuccess(reference);
  return reply(200, { success: true, data: { outcome } });
}

export async function processChargeSuccess(reference: string): Promise<WebhookOutcome> {
  const eventKey = `charge.success:${reference}`;

  // Idempotency lock: the unique eventKey means concurrent deliveries all land on the same row.
  let existing;
  try {
    existing = await WebhookEvent.findOneAndUpdate(
      { eventKey },
      { $setOnInsert: { eventKey, type: "charge.success", reference, receivedAt: new Date() } },
      { upsert: true, returnDocument: "before" },
    );
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    existing = await WebhookEvent.findOne({ eventKey }); // lost the insert race to a concurrent delivery
  }
  if (existing?.processedAt) return "DUPLICATE";

  // If anything below throws, processedAt stays empty, so Paystack's retry will run it again.
  const outcome = await settle(reference);
  await WebhookEvent.updateOne({ eventKey }, { processedAt: new Date(), outcome });
  return outcome;
}

async function settle(reference: string): Promise<WebhookOutcome> {
  const order = await Order.findOne({ "payment.reference": reference });
  if (!order) return "UNKNOWN_REFERENCE";

  if (order.status === "PAID") {
    await finalizePaidOrder(order); // repairs a previous run that stopped halfway
    return "ALREADY_PAID";
  }

  const verified = await getPaymentGateway().verify(reference);
  if (!verified || verified.status !== "success") return "NOT_SUCCESSFUL";

  if (verified.currency !== "NGN" || verified.amountKobo !== order.totalKobo) {
    await Order.updateOne(
      { _id: order._id },
      { needsAttention: true, attentionReason: `Paystack reports ${verified.currency} ${verified.amountKobo} kobo, but the order total is ${order.totalKobo} kobo. Not marked paid.` },
    );
    return "AMOUNT_MISMATCH";
  }

  const paid = await Order.findOneAndUpdate(
    { _id: order._id, status: "PENDING_PAYMENT" },
    { status: "PAID", "payment.paystackId": verified.paystackId, "payment.channel": verified.channel, "payment.paidAt": verified.paidAt ?? new Date() },
    { returnDocument: "after" },
  );

  if (!paid) {
    const now = await Order.findById(order._id);
    if (now?.status === "PAID") {
      await finalizePaidOrder(now);
      return "ALREADY_PAID"; // a concurrent delivery won
    }
    // The order was cancelled or expired before the money arrived. Keep the record, raise a flag, pay nothing out.
    await Order.updateOne(
      { _id: order._id },
      {
        needsAttention: true,
        attentionReason: "Payment received after the order was cancelled or expired. Refund the customer in Paystack, or contact them.",
        "payment.paystackId": verified.paystackId,
        "payment.channel": verified.channel,
        "payment.paidAt": verified.paidAt ?? new Date(),
      },
    );
    return "LATE_PAYMENT";
  }

  await finalizePaidOrder(paid);
  return "PAID";
}

/**
 * Moves each still-unpaid sub-order to PAID, logs it, and counts the sale. Each sub-order change is a
 * guarded update, so every side effect happens exactly once even if this runs twice or concurrently.
 */
async function finalizePaidOrder(order: OrderDoc): Promise<void> {
  const pending = await SubOrder.find({ orderId: order._id, status: "PENDING_PAYMENT" });
  const movedSubs: SubOrderDoc[] = [];
  for (const sub of pending) {
    const moved = await SubOrder.findOneAndUpdate(
      { _id: sub._id, status: "PENDING_PAYMENT" },
      { status: "PAID", paidAt: order.payment!.paidAt ?? new Date() },
      { returnDocument: "after" },
    );
    if (!moved) continue;
    movedSubs.push(moved);
    await StatusLog.create({ subOrderId: sub._id, orderId: order._id, from: "PENDING_PAYMENT", to: "PAID", actorRole: "SYSTEM", note: "Payment confirmed" });
    await Promise.all(moved.items.map((i) => Product.updateOne({ _id: i.productId }, { $inc: { soldCount: i.qty } })));
  }
  // Told once, by whichever call actually moved the sub-orders, so a replay cannot notify twice.
  if (movedSubs.length) await notifyOrderPaid(order, movedSubs);
  // With automatic assignment on, each paid delivery goes straight to a handler. A failure here must never undo or fail the payment.
  for (const sub of movedSubs) await autoAssign(sub._id).catch((err) => console.error(`Could not auto-assign ${sub.ref}:`, err));
}
