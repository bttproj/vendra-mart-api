import { env, isProd } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { User, type UserDoc } from "../../models/User.js";
import { Vendor } from "../../models/Vendor.js";
import { VendorMessage, presentVendorMessage, type VendorMessageDoc } from "../../models/VendorMessage.js";
import { getNotifier } from "../../services/notifications/index.js";

// An admin writes to one store's owner from the vendor's page in the dashboard. The email goes out first and its result is
// reported: if it did not go, the admin is told and the attempt is recorded as failed, rather than the message quietly
// vanishing. The owner also gets a copy in their notification bell, so it is seen even if the email lands in spam.

const EXCERPT = 240;

export async function sendVendorMessage(vendorId: string, admin: UserDoc, input: { subject: string; body: string }): Promise<VendorMessageDoc> {
  const vendor = await Vendor.findById(vendorId);
  if (!vendor) throw AppError.notFound("Vendor not found");
  const owner = await User.findById(vendor.userId);
  if (!owner) throw AppError.notFound("This store has no owner account to write to");

  // In production a message must really be able to leave. (On a developer's computer it is printed in the log instead.)
  if (isProd && !env.RESEND_API_KEY && !env.SMTP_HOST) {
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Email is not set up on the server yet. Add the Resend key in the API settings, then try again.");
  }

  const to = { id: String(owner._id), name: owner.name, email: owner.email };
  const message = {
    kind: "ADMIN_MESSAGE",
    title: input.subject,
    body: input.body,
    link: "/vendor/",
    cta: "Open your dashboard",
    replyTo: admin.email,
  };
  const record = { vendorId: vendor._id, sentById: admin._id, sentByName: admin.name, toName: to.name, toEmail: to.email, subject: input.subject, body: input.body };

  const report = await getNotifier().send([to], message, { channels: "external" });
  if (!report.ok) {
    const reason = report.failures[0]?.message.slice(0, 300) ?? "The email could not be sent";
    await VendorMessage.create({ ...record, status: "FAILED", error: reason });
    console.error(`Admin message to vendor ${vendor._id} failed:`, reason);
    throw new AppError(502, "SERVICE_UNAVAILABLE", `The email could not be sent: ${reason}`);
  }

  // The bell copy is a convenience; if it fails the email has still gone.
  await getNotifier()
    .notify([to], { ...message, body: input.body.length > EXCERPT ? `${input.body.slice(0, EXCERPT).trimEnd()}...` : input.body }, { channels: "in-app" })
    .catch(() => {});

  const saved = await VendorMessage.create({ ...record, status: "SENT" });
  console.info(`Admin ${admin._id} emailed vendor ${vendor._id}`);
  return saved;
}

export async function listVendorMessages(vendorId: string) {
  if (!(await Vendor.exists({ _id: vendorId }))) throw AppError.notFound("Vendor not found");
  const rows = await VendorMessage.find({ vendorId }).sort({ createdAt: -1 }).limit(30);
  return rows.map(presentVendorMessage);
}
