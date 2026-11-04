import type { OrderDoc } from "../../models/Order.js";
import type { SubOrderDoc } from "../../models/SubOrder.js";
import { User, type UserDoc } from "../../models/User.js";
import { Vendor, type VendorDoc } from "../../models/Vendor.js";
import { getNotifier, type NotificationMessage, type Recipient } from "../../services/notifications/index.js";
import { formatNaira } from "../../utils/formatNaira.js";
import { deliveryPage, orderPage } from "../../utils/webLinks.js";
import { notifyDesks, notifyTeam } from "../accounts/team.js";

export type SubOrderEvent = "READY_FOR_PICKUP" | "ASSIGNED" | "PICKED_UP" | "DELIVERED" | "FAILED_DELIVERY" | "CANCELLED" | "COMPLETED";

const toRecipient = (u: UserDoc): Recipient => ({ id: String(u._id), name: u.name, email: u.email });
const send = (to: UserDoc[], message: NotificationMessage) => (to.length ? getNotifier().notify(to.map(toRecipient), message) : Promise.resolve());

async function parties(sub: SubOrderDoc) {
  const [customer, vendor, handler] = await Promise.all([
    User.findById(sub.customerId),
    Vendor.findById(sub.vendorId),
    sub.handlerId ? User.findById(sub.handlerId) : Promise.resolve(null),
  ]);
  const vendorUser = vendor ? await User.findById(vendor.userId) : null;
  return { customer, vendor: vendor as VendorDoc | null, vendorUser, handler };
}

/** A notification problem must never break the order action that caused it. */
async function safely(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (err) {
    console.error("Order notification failed:", (err as Error).message);
  }
}

/**
 * One payment can confirm several deliveries. The customer hears about it once, each vendor hears about
 * their own part, and the admin hears that deliveries now need handlers.
 */
export function notifyOrderPaid(order: OrderDoc, paidSubs: SubOrderDoc[]) {
  return safely(async () => {
    const customer = await User.findById(order.customerId);
    const names = new Map((await Vendor.find({ _id: { $in: paidSubs.map((s) => s.vendorId) } })).map((v) => [String(v._id), v]));

    if (customer) {
      await send([customer], {
        kind: "ORDER_PAID",
        title: "Payment received",
        body: `Order ${order.orderNumber} is confirmed. You paid ${formatNaira(order.totalKobo)} (items ${formatNaira(order.itemsSubtotalKobo)}, delivery ${formatNaira(order.deliveryTotalKobo)}). ${paidSubs.length === 1 ? "The vendor is" : `${paidSubs.length} vendors are`} getting your items ready.`,
        link: orderPage(order._id),
      });
    }
    for (const sub of paidSubs) {
      const vendor = names.get(String(sub.vendorId));
      const vendorUser = vendor ? await User.findById(vendor.userId) : null;
      const units = sub.items.reduce((n, i) => n + i.qty, 0);
      if (vendorUser) {
        await send([vendorUser], {
          kind: "NEW_ORDER",
          title: `New order ${sub.ref}`,
          body: `${units} ${units === 1 ? "item" : "items"} worth ${formatNaira(sub.itemsTotalKobo)} to prepare. Mark it ready for pickup when it is packed.`,
          link: "/vendor/orders",
        });
      }
    }
    const storeNames = paidSubs.map((s) => names.get(String(s.vendorId))?.businessName).filter(Boolean).join(", ");
    await notifyTeam(
      ["orders", "deliveries"],
      {
        kind: "ORDER_NEEDS_HANDLER",
        title: `New sale: order ${order.orderNumber} paid`,
        body: `${order.customer?.name ?? "A customer"} paid ${formatNaira(order.totalKobo)} to ${storeNames || "the vendors"}. ${paidSubs.length} ${paidSubs.length === 1 ? "delivery needs" : "deliveries need"} a handler.`,
        link: "/admin/deliveries",
      },
      { vendorDesk: true },
    );
  });
}

/** Status changes and assignments on one delivery. `actor` is skipped so nobody is told about their own click. */
export function notifySubOrderEvent(sub: SubOrderDoc, event: SubOrderEvent, opts: { actorId?: string; reason?: string } = {}) {
  return safely(async () => {
    const { customer, vendor, vendorUser, handler } = await parties(sub);
    const notSelf = (u: UserDoc | null): UserDoc[] => (u && String(u._id) !== opts.actorId ? [u] : []);
    const from = vendor?.businessName ?? "the vendor";
    const orderLink = orderPage(sub.orderId);

    switch (event) {
      case "READY_FOR_PICKUP":
        await send(notSelf(customer), { kind: "READY_FOR_PICKUP", title: "Your items are ready", body: `${from} has packed ${sub.ref} and it is waiting for a rider.`, link: orderLink });
        if (handler) {
          await send(notSelf(handler), { kind: "READY_FOR_PICKUP", title: `${sub.ref} is ready to collect`, body: `Pick up from ${from}: ${sub.delivery!.pickup!.line}.`, link: deliveryPage(sub._id) });
        } else {
          await notifyTeam("deliveries", { kind: "READY_UNASSIGNED", title: `${sub.ref} is ready but has no handler`, body: `${from} has it packed. Assign a delivery handler.`, link: "/admin/deliveries" }, { vendorDesk: true });
        }
        break;

      case "ASSIGNED":
        await send(notSelf(handler), {
          kind: "DELIVERY_ASSIGNED",
          title: `New delivery ${sub.ref}`,
          body: `Collect from ${from} (${sub.delivery!.pickup!.line}) and deliver to ${sub.delivery!.dropoff!.line}.`,
          link: deliveryPage(sub._id),
        });
        await send(notSelf(vendorUser), { kind: "HANDLER_ASSIGNED", title: `Rider assigned to ${sub.ref}`, body: "A delivery handler will collect this order when it is ready.", link: "/vendor/orders" });
        break;

      case "PICKED_UP":
        await send(notSelf(customer), { kind: "PICKED_UP", title: "On its way", body: `${sub.ref} from ${from} has been picked up and is heading to you.`, link: orderLink });
        await send(notSelf(vendorUser), { kind: "PICKED_UP", title: `${sub.ref} picked up`, body: "The rider has collected this order.", link: "/vendor/orders" });
        break;

      case "DELIVERED":
        await send(notSelf(customer), { kind: "DELIVERED", title: "Delivered", body: `${sub.ref} from ${from} has been delivered. Enjoy!`, link: orderLink });
        await send(notSelf(vendorUser), { kind: "DELIVERED", title: `${sub.ref} delivered`, body: "Your earnings for this order unlock 4 working days after delivery.", link: "/vendor/earnings" });
        break;

      case "FAILED_DELIVERY":
        await send(notSelf(customer), { kind: "FAILED_DELIVERY", title: "We could not deliver your order", body: `${sub.ref}: ${opts.reason ?? "the delivery was not completed"}. We will contact you.`, link: orderLink });
        await send(notSelf(vendorUser), { kind: "FAILED_DELIVERY", title: `${sub.ref} delivery failed`, body: opts.reason ?? "The delivery was not completed.", link: "/vendor/orders" });
        await notifyTeam(["deliveries", "orders"], { kind: "FAILED_DELIVERY", title: `${sub.ref} delivery failed`, body: `${from}: ${opts.reason ?? "the handler reported a failed delivery"}.`, link: "/admin/deliveries" }, { vendorDesk: true });
        break;

      case "CANCELLED":
        await send(notSelf(customer), { kind: "CANCELLED", title: "Part of your order was cancelled", body: `${sub.ref} from ${from} was cancelled. We will be in touch about a refund.`, link: orderLink });
        await send(notSelf(vendorUser), { kind: "CANCELLED", title: `${sub.ref} was cancelled`, body: "This order will not go ahead.", link: "/vendor/orders" });
        await notifyTeam("orders", { kind: "CANCELLED", title: `${sub.ref} was cancelled`, body: `${from}: the customer was paid for, so a refund is needed. See the order for the amount.`, link: "/admin/orders" }, { vendorDesk: true });
        break;

      case "COMPLETED":
        await send(notSelf(vendorUser), { kind: "EARNINGS_AVAILABLE", title: `Earnings from ${sub.ref} are available`, body: "The hold has ended. You can request a payout for this order now.", link: "/vendor/earnings" });
        break;
    }

    // The shared mailboxes keep a record of the routine steps too, so nothing happens on the site without them knowing.
    const step: Partial<Record<SubOrderEvent, string>> = {
      READY_FOR_PICKUP: "is packed and ready for pickup",
      ASSIGNED: "was given to a delivery handler",
      PICKED_UP: "was picked up and is out for delivery",
      DELIVERED: "was delivered",
      COMPLETED: "is complete and the vendor earnings are available",
    };
    if (step[event]) {
      await notifyDesks({ kind: `TEAM_${event}`, title: `${sub.ref} ${step[event]}`, body: `${from}${handler ? `, handler ${handler.name}` : ""}.`, link: "/admin/deliveries" }, { vendorDesk: true });
    }
  });
}
