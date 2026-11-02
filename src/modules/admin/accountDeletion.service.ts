import type { OrderStatus } from "../../domain/orderStateMachine.js";
import { AppError } from "../../utils/AppError.js";
import { PLACEHOLDER_PREFIX } from "../../config/placeholderImages.js";
import { Address } from "../../models/Address.js";
import { EmailToken } from "../../models/EmailToken.js";
import { Notification } from "../../models/Notification.js";
import { Order } from "../../models/Order.js";
import { Payout } from "../../models/Payout.js";
import { Product } from "../../models/Product.js";
import { StatusLog } from "../../models/StatusLog.js";
import { SubOrder } from "../../models/SubOrder.js";
import { User, type UserDoc } from "../../models/User.js";
import { VendorMessage } from "../../models/VendorMessage.js";
import { Vendor } from "../../models/Vendor.js";
import { getNotifier } from "../../services/notifications/index.js";
import { getImageStorage, getPrivateStorage } from "../../services/storage/index.js";

// The Super Admin can permanently delete a customer, a store or a delivery handler. The records go from the database for
// good (and a store's pictures from Cloudinary). Anything that is part of the money trail is protected: an account that
// has paid orders, deliveries in progress or payouts cannot be deleted, because deleting it would break the order history,
// earnings and refund records of other people. Those accounts can be deactivated or suspended instead.

const UNPAID: OrderStatus[] = ["PENDING_PAYMENT", "CANCELLED"];
const IN_PROGRESS: OrderStatus[] = ["PAID", "READY_FOR_PICKUP", "PICKED_UP", "FAILED_DELIVERY"];

export interface DeletionResult {
  id: string;
  name: string;
  role: UserDoc["role"];
  /** What was removed along with the account, for the confirmation shown to the admin. */
  removed: Record<string, number>;
}

function refuse(reason: string): never {
  throw new AppError(409, "CONFLICT", `${reason} Deactivate or suspend the account instead, which keeps the records.`);
}

/** Tells the person, by email only, before their account goes. A mail problem never stops the deletion. */
async function sayGoodbye(user: UserDoc) {
  try {
    await getNotifier().notify(
      [{ id: String(user._id), name: user.name, email: user.email }],
      {
        kind: "ACCOUNT_DELETED",
        title: "Your VendraMart account has been removed",
        body: "Our team has removed your VendraMart account and the details stored with it.\n\nIf you think this is a mistake, please contact us on the number in the footer of the website.",
        link: "/help/",
        cta: "Contact us",
      },
      { channels: "external" },
    );
  } catch (err) {
    console.error("Could not send the account removed email:", (err as Error).message);
  }
}

const quietly = (work: () => Promise<unknown>) => work().catch(() => {});

async function removeUserTrail(user: UserDoc) {
  await Promise.all([Notification.deleteMany({ userId: user._id }), EmailToken.deleteMany({ userId: user._id })]);
  await User.deleteOne({ _id: user._id });
}

async function findUser(id: string, role: UserDoc["role"], label: string) {
  const user = await User.findOne({ _id: id, role });
  if (!user) throw AppError.notFound(`${label} not found`);
  return user;
}

export async function deleteCustomer(id: string): Promise<DeletionResult> {
  const user = await findUser(id, "CUSTOMER", "Customer");
  if (await Order.exists({ customerId: user._id, $or: [{ status: "PAID" }, { needsAttention: true }, { "payment.paidAt": { $exists: true } }] })) {
    refuse("This customer has paid orders, which are part of the sales and refund records.");
  }
  if (await Order.exists({ customerId: user._id, status: "PENDING_PAYMENT" })) {
    refuse("This customer has an order waiting for payment right now.");
  }
  await sayGoodbye(user);

  // What is left are cancelled and abandoned orders that never took any money.
  const orders = await Order.find({ customerId: user._id }).select("_id");
  const orderIds = orders.map((o) => o._id);
  const [logs, subs, ords, addresses] = await Promise.all([
    StatusLog.deleteMany({ orderId: { $in: orderIds } }),
    SubOrder.deleteMany({ orderId: { $in: orderIds } }),
    Order.deleteMany({ _id: { $in: orderIds } }),
    Address.deleteMany({ userId: user._id }),
  ]);
  await removeUserTrail(user);
  console.info(`Admin deleted customer ${user._id}`);
  return { id: String(user._id), name: user.name, role: user.role, removed: { orders: ords.deletedCount, subOrders: subs.deletedCount, statusLogs: logs.deletedCount, addresses: addresses.deletedCount } };
}

export async function deleteHandler(id: string): Promise<DeletionResult> {
  const user = await findUser(id, "HANDLER", "Staff account");
  if (await SubOrder.exists({ handlerId: user._id, status: { $in: IN_PROGRESS } })) {
    refuse("This handler still has deliveries in progress. Reassign them first.");
  }
  await sayGoodbye(user);
  // Finished deliveries keep their history; they just no longer point at a person who is gone.
  const freed = await SubOrder.updateMany({ handlerId: user._id }, { $unset: { handlerId: 1 } });
  await removeUserTrail(user);
  console.info(`Admin deleted handler ${user._id}`);
  return { id: String(user._id), name: user.name, role: user.role, removed: { deliveriesUnassigned: freed.modifiedCount } };
}

export async function deleteVendor(id: string): Promise<DeletionResult> {
  const vendor = await Vendor.findById(id);
  if (!vendor) throw AppError.notFound("Vendor not found");
  if (await SubOrder.exists({ vendorId: vendor._id, status: { $nin: UNPAID } })) {
    refuse("This store has orders that were paid or are being delivered, which are part of the sales and earnings records.");
  }
  if (await SubOrder.exists({ vendorId: vendor._id, status: "PENDING_PAYMENT" })) {
    refuse("A customer is paying for an order from this store right now.");
  }
  if (await Payout.exists({ vendorId: vendor._id })) {
    refuse("This store has payout records.");
  }
  const owner = await User.findById(vendor.userId);
  if (owner) await sayGoodbye(owner);

  // Cancelled orders that never took money, then the catalogue.
  const subs = await SubOrder.find({ vendorId: vendor._id }).select("_id");
  const subIds = subs.map((s) => s._id);
  const [logs, subOrders] = await Promise.all([StatusLog.deleteMany({ subOrderId: { $in: subIds } }), SubOrder.deleteMany({ _id: { $in: subIds } })]);

  const products = await Product.find({ vendorId: vendor._id }).select("images");
  const publicIds = products.flatMap((p) => p.images.map((i) => i.publicId)).filter((p) => !p.startsWith(PLACEHOLDER_PREFIX));
  const productResult = await Product.deleteMany({ vendorId: vendor._id });

  // Files in Cloudinary: product photos, the logo (public), and the NIN slip (private).
  if (vendor.logoPublicId) publicIds.push(vendor.logoPublicId);
  let storage: ReturnType<typeof getImageStorage> | null = null;
  try {
    storage = getImageStorage();
  } catch {
    /* no image storage is configured, so there is nothing to clean up there */
  }
  if (storage) await Promise.all(publicIds.map((p) => quietly(() => storage!.remove(p))));
  if (vendor.ninSlip?.publicId) {
    const slip = vendor.ninSlip;
    await quietly(() => getPrivateStorage().remove(slip.publicId!, slip.resourceType ?? undefined));
  }

  await VendorMessage.deleteMany({ vendorId: vendor._id });
  await Vendor.deleteOne({ _id: vendor._id });
  if (owner) await removeUserTrail(owner);
  console.info(`Admin deleted vendor ${vendor._id}`);
  return {
    id: String(vendor._id),
    name: vendor.businessName,
    role: "VENDOR",
    removed: { products: productResult.deletedCount, images: publicIds.length, cancelledOrderParts: subOrders.deletedCount, statusLogs: logs.deletedCount },
  };
}
