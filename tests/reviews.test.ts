import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { averageTenths, isRating, ratingSummary, reviewerName } from "../src/domain/rating.js";
import { Notification } from "../src/models/Notification.js";
import { Product } from "../src/models/Product.js";
import { Review } from "../src/models/Review.js";
import { SubOrder } from "../src/models/SubOrder.js";
import { api, clearDb, createCustomer, createProduct, loginToken, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin, paidOrder } from "./fulfilmentHelpers.js";

describe("rating rules", () => {
  it("accepts only whole stars from 1 to 5", () => {
    for (const n of [1, 2, 3, 4, 5]) expect(isRating(n)).toBe(true);
    for (const n of [0, 6, -1, 2.5, "5", null, undefined, NaN]) expect(isRating(n), String(n)).toBe(false);
  });

  it("works the average out in whole tenths, rounding half up", () => {
    expect(averageTenths(0, 0)).toBe(0);
    expect(averageTenths(5, 1)).toBe(50);
    expect(averageTenths(9, 2)).toBe(45); // 4.5
    expect(averageTenths(13, 3)).toBe(43); // 4.333 -> 4.3
    expect(averageTenths(14, 3)).toBe(47); // 4.667 -> 4.7
    expect(averageTenths(87, 20)).toBe(44); // 4.35 is exactly half: up, never lost to a float
    expect(averageTenths(7, 2)).toBe(35);
    expect(() => averageTenths(-1, 2)).toThrow();
    expect(() => averageTenths(1.5, 2)).toThrow();
  });

  it("gives the average to one decimal with the count, and zeros when there is nothing", () => {
    expect(ratingSummary(13, 3)).toEqual({ average: 4.3, count: 3 });
    expect(ratingSummary(undefined, undefined)).toEqual({ average: 0, count: 0 });
    expect(ratingSummary(null, 0)).toEqual({ average: 0, count: 0 });
  });

  it("shows a reviewer as a first name and one initial", () => {
    expect(reviewerName("Ada Okafor")).toBe("Ada O.");
    expect(reviewerName("  ada   bola  okafor ")).toBe("ada O.");
    expect(reviewerName("Ada")).toBe("Ada");
    expect(reviewerName("   ")).toBe("Customer");
  });
});

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

/** The checkout order, paid. Bodija's delivery can then be marked delivered; Oja'ba's is left waiting. */
async function order() {
  const o = await paidOrder();
  const deliver = (id: unknown, status: "DELIVERED" | "COMPLETED" = "DELIVERED") => SubOrder.updateOne({ _id: id }, { status, deliveredAt: new Date() });
  const c = asUser(o.customer.bearer);
  const review = (productId: unknown, body: Record<string, unknown> = {}) => c.post("/reviews", { productId: String(productId), rating: 5, comment: "Fresh and well packed.", ...body });
  // A review waits for approval. This approver is made only when a test asks for one.
  let approver: string | undefined;
  const approverBearer = async () => (approver ??= (await createAdmin("approver@example.com")).bearer);
  const approve = async (id: unknown) => asUser(await approverBearer()).post(`/admin/reviews/${id}/approve`);
  return { ...o, deliver, c, review, approve, approverBearer };
}

describe("who may review", () => {
  it("is only a customer whose delivery of the product has arrived", async () => {
    const o = await order();
    // Paid but not delivered yet.
    const early = await o.review(o.flour._id);
    expect(early.status).toBe(403);
    expect(early.body.error.message).toMatch(/once it has been delivered/);
    expect(await Review.countDocuments()).toBe(0);

    await o.deliver(o.bodijaSub._id);
    expect((await o.review(o.flour._id)).status).toBe(201);
  });

  it("counts a completed delivery too, but not one that failed or was cancelled", async () => {
    const o = await order();
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "FAILED_DELIVERY" });
    expect((await o.review(o.flour._id)).status).toBe(403);
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "CANCELLED" });
    expect((await o.review(o.flour._id)).status).toBe(403);
    await o.deliver(o.bodijaSub._id, "COMPLETED");
    expect((await o.review(o.flour._id)).status).toBe(201);
  });

  it("is only for the products in that delivery, not another store's still on the way", async () => {
    const o = await order();
    await o.deliver(o.bodijaSub._id);
    expect((await o.review(o.oil._id)).status).toBe(403); // Oja'ba's parcel has not arrived
    const stranger = await createProduct(o.bodija.vendor, { name: "Never bought" });
    expect((await o.review(stranger._id)).status).toBe(403);
  });

  it("is not for another customer, a vendor, an admin or a signed-out visitor", async () => {
    const o = await order();
    await o.deliver(o.bodijaSub._id);
    const other = await createCustomer();
    expect((await asUser(other.bearer).post("/reviews", { productId: String(o.flour._id), rating: 5 })).status).toBe(403);
    expect((await asUser(o.vendorTokens.bodija).post("/reviews", { productId: String(o.flour._id), rating: 5 })).status).toBe(403);
    expect((await asUser((await createAdmin()).bearer).post("/reviews", { productId: String(o.flour._id), rating: 5 })).status).toBe(403);
    expect((await api().post("/api/reviews").send({ productId: String(o.flour._id), rating: 5 })).status).toBe(401);
  });

  it("cannot review a product that has since been removed", async () => {
    const o = await order();
    await o.deliver(o.bodijaSub._id);
    await Product.deleteOne({ _id: o.flour._id });
    expect((await o.review(o.flour._id)).status).toBe(404);
  });
});

describe("writing, changing and deleting a review", () => {
  it("saves the stars and words, shows the author as a short name, and holds it for approval", async () => {
    const o = await order();
    await o.deliver(o.bodijaSub._id);
    const res = await o.review(o.flour._id, { rating: 4, comment: "  Good flour.  " });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ rating: 4, comment: "Good flour.", productId: String(o.flour._id), edited: false, status: "PENDING" });
    expect(res.body.data.authorName).toMatch(/ U\.$/); // "CUSTOMER U.": first name and an initial
    // Not counted until an admin approves it.
    expect(await Product.findById(o.flour._id)).toMatchObject({ ratingCount: 0, ratingSum: 0 });
    expect((await o.approve(res.body.data.id)).status).toBe(200);
    expect(await Product.findById(o.flour._id)).toMatchObject({ ratingCount: 1, ratingSum: 4 });
    expect(await Review.findOne({ productId: o.flour._id })).toMatchObject({ productName: o.flour.name, subOrderId: o.bodijaSub._id });
  });

  it("allows the words to be left out", async () => {
    const o = await order();
    await o.deliver(o.bodijaSub._id);
    const res = await o.c.post("/reviews", { productId: String(o.flour._id), rating: 3 });
    expect(res.status).toBe(201);
    expect(res.body.data.comment).toBe("");
  });

  it("allows one review a product: a second is refused and points at editing", async () => {
    const o = await order();
    await o.deliver(o.bodijaSub._id);
    await o.review(o.flour._id);
    const again = await o.review(o.flour._id, { rating: 1 });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/already reviewed/);
    expect(await Review.countDocuments()).toBe(1);
  });

  it("refuses stars that are not whole numbers from 1 to 5, long words, extra fields and bad ids", async () => {
    const o = await order();
    await o.deliver(o.bodijaSub._id);
    const bad: Record<string, unknown>[] = [{ rating: 0 }, { rating: 6 }, { rating: 2.5 }, { rating: "5" }, { rating: undefined }, { comment: "x".repeat(1001) }, { extra: true }, { productId: "nope" }];
    for (const over of bad) expect((await o.review(o.flour._id, over)).status, JSON.stringify(over)).toBe(422);
    expect(await Review.countDocuments()).toBe(0);
    expect((await o.review(o.flour._id, { comment: "x".repeat(1000) })).status).toBe(201); // the limit itself is fine
  });

  it("lets the author change a review that is still waiting, without touching the totals", async () => {
    const o = await order();
    await o.deliver(o.bodijaSub._id);
    const made = (await o.review(o.flour._id, { rating: 5 })).body.data;
    const res = await o.c.patch(`/reviews/${made.id}`, { rating: 2, comment: "It arrived damp." });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ rating: 2, comment: "It arrived damp.", status: "PENDING" });
    expect(await Product.findById(o.flour._id)).toMatchObject({ ratingCount: 0, ratingSum: 0 });
    expect((await o.c.patch(`/reviews/${made.id}`, {})).status).toBe(422);
    expect((await o.c.patch(`/reviews/${made.id}`, { rating: 9 })).status).toBe(422);
  });

  it("sends an approved review back for approval when its author changes it, and takes its stars out of the average until then", async () => {
    const o = await order();
    await o.deliver(o.bodijaSub._id);
    const made = (await o.review(o.flour._id, { rating: 5 })).body.data;
    await o.approve(made.id);
    expect(await Product.findById(o.flour._id)).toMatchObject({ ratingCount: 1, ratingSum: 5 });

    const res = await o.c.patch(`/reviews/${made.id}`, { rating: 2, comment: "Changed my mind." });
    expect(res.body.data).toMatchObject({ rating: 2, status: "PENDING" });
    expect(await Product.findById(o.flour._id)).toMatchObject({ ratingCount: 0, ratingSum: 0 });
    expect((await api().get(`/api/products/${o.flour.slug}/reviews`)).body.data.reviews).toHaveLength(0); // not public while it waits

    await o.approve(made.id);
    expect(await Product.findById(o.flour._id)).toMatchObject({ ratingCount: 1, ratingSum: 2 });
    expect((await api().get(`/api/products/${o.flour.slug}/reviews`)).body.data.reviews[0]).toMatchObject({ rating: 2, comment: "Changed my mind.", edited: true });
  });

  it("lets the author delete it: a waiting one leaves the totals alone, an approved one comes out of them", async () => {
    const o = await order();
    await o.deliver(o.bodijaSub._id);
    const waiting = (await o.review(o.flour._id)).body.data;
    expect((await o.c.delete(`/reviews/${waiting.id}`)).status).toBe(200);
    expect(await Review.countDocuments()).toBe(0);
    expect(await Product.findById(o.flour._id)).toMatchObject({ ratingCount: 0, ratingSum: 0 });

    const made = (await o.review(o.flour._id, { rating: 3 })).body.data; // and they may write a new one
    await o.approve(made.id);
    expect(await Product.findById(o.flour._id)).toMatchObject({ ratingCount: 1, ratingSum: 3 });
    expect((await o.c.delete(`/reviews/${made.id}`)).status).toBe(200);
    expect(await Product.findById(o.flour._id)).toMatchObject({ ratingCount: 0, ratingSum: 0 });
  });

  it("keeps one customer from changing or deleting another's review", async () => {
    const o = await order();
    await o.deliver(o.bodijaSub._id);
    const made = (await o.review(o.flour._id)).body.data;
    const other = asUser((await createCustomer()).bearer);
    expect((await other.patch(`/reviews/${made.id}`, { rating: 1 })).status).toBe(404);
    expect((await other.delete(`/reviews/${made.id}`)).status).toBe(404);
    expect(await Review.findById(made.id)).toMatchObject({ rating: 5 });
  });

  it("tells the vendor in the app, and not by email, once the review is approved", async () => {
    const o = await order();
    await o.deliver(o.bodijaSub._id);
    const made = (await o.review(o.flour._id, { rating: 2, comment: "Not as described." })).body.data;
    expect(await Notification.countDocuments({ userId: o.bodija.user._id, kind: "NEW_REVIEW" })).toBe(0); // not while it waits
    await o.approve(made.id);
    await o.approve(made.id); // approving twice tells them once
    expect(await Notification.countDocuments({ userId: o.bodija.user._id, kind: "NEW_REVIEW" })).toBe(1);
    const note = (await Notification.find({ userId: o.bodija.user._id, kind: "NEW_REVIEW" }))[0]!;
    expect(note.title).toBe(`New 2-star review on ${o.flour.name}`);
    expect(note.body).toContain("Not as described.");
    expect(note.link).toBe("/vendor/products");
  });
});

describe("what shoppers see", () => {
  /** A delivered review from the real customer, plus extra reviews from others written straight in. */
  async function reviewed() {
    const o = await order();
    await o.deliver(o.bodijaSub._id);
    await o.approve((await o.review(o.flour._id, { rating: 5, comment: "Great." })).body.data.id);
    for (const [name, stars] of [["Bola Adeyemi", 4], ["Chidi Eze", 3]] as const) {
      const buyer = await createCustomer();
      await Review.create({ customerId: buyer.user._id, productId: o.flour._id, vendorId: o.bodija.vendor._id, subOrderId: o.bodijaSub._id, rating: stars, comment: `${name.split(" ")[0]} says ${stars}`, authorName: `${name.split(" ")[0]} ${name.split(" ")[1]![0]}.`, productName: o.flour.name, status: "APPROVED" });
      await Product.updateOne({ _id: o.flour._id }, { $inc: { ratingCount: 1, ratingSum: stars } });
    }
    return o;
  }

  it("lists a product's reviews with the average, the count and how many gave each number of stars", async () => {
    const o = await reviewed();
    const res = await api().get(`/api/products/${o.flour.slug}/reviews`);
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toEqual({ average: 4, count: 3, breakdown: { "1": 0, "2": 0, "3": 1, "4": 1, "5": 1 } });
    expect(res.body.data.reviews).toHaveLength(3);
    expect(res.body.meta).toMatchObject({ total: 3, page: 1 });
  });

  it("shows only a short name: never an email, a full name or an id of the customer", async () => {
    const o = await reviewed();
    const text = JSON.stringify((await api().get(`/api/products/${o.flour.slug}/reviews`)).body);
    expect(text).not.toContain("@example.com");
    expect(text).not.toContain("customerId");
    expect(text).not.toContain("Adeyemi");
    expect(text).toContain("Bola A.");
  });

  it("pages the reviews, newest first", async () => {
    const o = await reviewed();
    const first = await api().get(`/api/products/${o.flour.slug}/reviews?limit=2`);
    const second = await api().get(`/api/products/${o.flour.slug}/reviews?limit=2&page=2`);
    expect(first.body.data.reviews).toHaveLength(2);
    expect(second.body.data.reviews).toHaveLength(1);
    const times = [...first.body.data.reviews, ...second.body.data.reviews].map((r: { createdAt: string }) => new Date(r.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("is not found for an unknown product, a hidden one, or one from a store that is not live", async () => {
    const o = await reviewed();
    expect((await api().get("/api/products/nope/reviews")).status).toBe(404);
    await Product.updateOne({ _id: o.flour._id }, { isActive: false });
    expect((await api().get(`/api/products/${o.flour.slug}/reviews`)).status).toBe(404);
    expect((await api().get(`/api/products/${o.flour.slug}/reviews?limit=500`)).status).toBe(422);
  });

  it("puts the average on product cards, the product page and the store page", async () => {
    const o = await reviewed();
    expect((await api().get(`/api/products/${o.flour.slug}`)).body.data.rating).toEqual({ average: 4, count: 3 });
    const list = await api().get("/api/products");
    expect(list.body.data.find((p: { slug: string }) => p.slug === o.flour.slug).rating).toEqual({ average: 4, count: 3 });
    expect(list.body.data.find((p: { slug: string }) => p.slug === o.oil.slug).rating).toEqual({ average: 0, count: 0 });
    expect((await api().get(`/api/vendors/${o.bodija.vendor.slug}`)).body.data.rating).toEqual({ average: 4, count: 3 });
    expect((await api().get(`/api/vendors/${o.ojaba.vendor.slug}`)).body.data.rating).toEqual({ average: 0, count: 0 });
  });

  it("keeps a review that is waiting for approval out of the list, the count, the breakdown, the cards and the store page", async () => {
    const o = await reviewed();
    const buyer = await createCustomer();
    await Review.create({ customerId: buyer.user._id, productId: o.flour._id, vendorId: o.bodija.vendor._id, subOrderId: o.bodijaSub._id, rating: 1, comment: "Waiting to be checked", authorName: "Dayo F.", productName: o.flour.name, status: "PENDING" });
    const list = await api().get(`/api/products/${o.flour.slug}/reviews`);
    expect(list.body.data.reviews).toHaveLength(3);
    expect(JSON.stringify(list.body)).not.toContain("Waiting to be checked");
    expect(list.body.data.summary).toEqual({ average: 4, count: 3, breakdown: { "1": 0, "2": 0, "3": 1, "4": 1, "5": 1 } });
    expect((await api().get(`/api/products/${o.flour.slug}`)).body.data.rating).toEqual({ average: 4, count: 3 });
    expect((await api().get(`/api/vendors/${o.bodija.vendor.slug}`)).body.data.rating).toEqual({ average: 4, count: 3 });
  });

  it("still shows a review saved before approval existed (it has no status)", async () => {
    const o = await reviewed();
    const buyer = await createCustomer();
    const old = await Review.create({ customerId: buyer.user._id, productId: o.flour._id, vendorId: o.bodija.vendor._id, subOrderId: o.bodijaSub._id, rating: 2, comment: "From before", authorName: "Old R.", productName: o.flour.name });
    await Review.collection.updateOne({ _id: old._id }, { $unset: { status: "" } });
    const list = await api().get(`/api/products/${o.flour.slug}/reviews`);
    expect(list.body.data.reviews.map((r: { comment: string }) => r.comment)).toContain("From before");
  });
});

describe("the customer's order page", () => {
  it("says which items can be rated, and shows the review once it is written, with whether it is approved yet", async () => {
    const o = await order();
    const items = async () => (await o.c.get(`/orders/${o.data.orderId}`)).body.data.subOrders as { id: string; items: { name: string; canReview: boolean; review: { rating: number; status: string } | null }[] }[];
    const bodijaItem = async () => (await items()).find((s) => s.id === String(o.bodijaSub._id))!.items[0]!;

    expect(await bodijaItem()).toMatchObject({ canReview: false, review: null }); // not delivered yet
    await o.deliver(o.bodijaSub._id);
    expect(await bodijaItem()).toMatchObject({ canReview: true, review: null });
    const ojaba = (await items()).find((s) => s.id === String(o.ojabaSub._id))!.items[0]!;
    expect(ojaba.canReview).toBe(false); // the other store's parcel is still on its way

    const made = (await o.review(o.flour._id, { rating: 4 })).body.data;
    expect(await bodijaItem()).toMatchObject({ canReview: false, review: { rating: 4, comment: "Fresh and well packed.", status: "PENDING" } });
    await o.approve(made.id);
    expect(await bodijaItem()).toMatchObject({ review: { status: "APPROVED" } });
  });

  it("asks the customer to rate when the parcel is delivered", async () => {
    const o = await order();
    const { notifySubOrderEvent } = await import("../src/modules/orders/orderEvents.js");
    await o.deliver(o.bodijaSub._id);
    await notifySubOrderEvent((await SubOrder.findById(o.bodijaSub._id))!, "DELIVERED");
    const note = (await Notification.find({ userId: o.customer.user._id, kind: "DELIVERED" }))[0]!;
    expect(note.body).toMatch(/Rate your items/);
  });
});

describe("approving or deleting reviews (admin)", () => {
  async function oneReview() {
    const o = await order();
    await o.deliver(o.bodijaSub._id);
    const made = (await o.review(o.flour._id, { rating: 1, comment: "Rude seller" })).body.data;
    return { ...o, made, admin: await createAdmin() };
  }

  it("lists reviews for the admin with their status, who wrote them and which store, and filters them", async () => {
    const o = await oneReview();
    const res = await asUser(o.admin.bearer).get("/admin/reviews");
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ rating: 1, status: "PENDING", comment: "Rude seller", productName: o.flour.name, vendor: { businessName: "Bodija Provisions" }, customer: { email: o.customer.email } });
    const get = async (q: string) => (await asUser(o.admin.bearer).get(`/admin/reviews?${q}`)).body.data.length;
    expect(await get("rating=1")).toBe(1);
    expect(await get("rating=5")).toBe(0);
    expect(await get("q=rude")).toBe(1);
    expect(await get("q=.*")).toBe(0);
    expect(await get(`vendorId=${o.ojaba.vendor._id}`)).toBe(0);
    expect(await get("status=PENDING")).toBe(1);
    expect(await get("status=APPROVED")).toBe(0);
    expect((await asUser(o.admin.bearer).get("/admin/reviews?rating=9")).status).toBe(422);
    expect((await asUser(o.admin.bearer).get("/admin/reviews?status=MAYBE")).status).toBe(422);
  });

  it("counts the reviews waiting and the ones that are public", async () => {
    const o = await oneReview();
    expect((await asUser(o.admin.bearer).get("/admin/reviews/counts")).body.data).toEqual({ pending: 1, approved: 0 });
    await asUser(o.admin.bearer).post(`/admin/reviews/${o.made.id}/approve`);
    expect((await asUser(o.admin.bearer).get("/admin/reviews/counts")).body.data).toEqual({ pending: 0, approved: 1 });
  });

  it("lets the admin approve one: it goes public, counts once, and approving again changes nothing", async () => {
    const o = await oneReview();
    expect((await api().get(`/api/products/${o.flour.slug}/reviews`)).body.data.reviews).toHaveLength(0);
    const res = await asUser(o.admin.bearer).post(`/admin/reviews/${o.made.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: o.made.id, status: "APPROVED" });
    expect(await Review.findById(o.made.id)).toMatchObject({ status: "APPROVED", approvedBy: o.admin.user._id });
    await asUser(o.admin.bearer).post(`/admin/reviews/${o.made.id}/approve`);
    expect(await Product.findById(o.flour._id)).toMatchObject({ ratingCount: 1, ratingSum: 1 });
    expect((await api().get(`/api/products/${o.flour.slug}/reviews`)).body.data.reviews).toHaveLength(1);
    expect((await asUser(o.admin.bearer).post("/admin/reviews/64b000000000000000000000/approve")).status).toBe(404);
    expect((await asUser(o.admin.bearer).post("/admin/reviews/nope/approve")).status).toBe(422);
  });

  it("lets the admin delete a waiting review, and the totals stay as they were", async () => {
    const o = await oneReview();
    expect((await asUser(o.admin.bearer).delete(`/admin/reviews/${o.made.id}`)).status).toBe(200);
    expect(await Review.countDocuments()).toBe(0);
    expect(await Product.findById(o.flour._id)).toMatchObject({ ratingCount: 0, ratingSum: 0 });
    expect((await asUser(o.admin.bearer).delete(`/admin/reviews/${o.made.id}`)).status).toBe(404);
    expect((await o.review(o.flour._id)).status).toBe(201); // the customer may write again
  });

  it("lets the admin delete a public review, and it comes out of the product's average", async () => {
    const o = await oneReview();
    await asUser(o.admin.bearer).post(`/admin/reviews/${o.made.id}/approve`);
    expect(await Product.findById(o.flour._id)).toMatchObject({ ratingCount: 1, ratingSum: 1 });
    expect((await asUser(o.admin.bearer).delete(`/admin/reviews/${o.made.id}`)).status).toBe(200);
    expect(await Product.findById(o.flour._id)).toMatchObject({ ratingCount: 0, ratingSum: 0 });
  });

  it("tells the product and vendor managers when a review is waiting", async () => {
    const o = await order();
    await o.deliver(o.bodijaSub._id);
    const admin = await createAdmin();
    const staff = (title: string, email: string) => asUser(admin.bearer).post("/admin/staff", { name: "Some Manager", email, phone: "08031234567", password: "Passw0rdTest", role: "STAFF", staffTitle: title });
    const pm = (await staff("PRODUCT_MANAGER", "product@example.com")).body.data;
    const fm = (await staff("FINANCE_MANAGER", "finance@example.com")).body.data;
    await o.review(o.flour._id, { rating: 3 });
    expect(await Notification.countDocuments({ userId: pm.id, kind: "REVIEW_PENDING" })).toBe(1);
    expect(await Notification.countDocuments({ userId: fm.id, kind: "REVIEW_PENDING" })).toBe(0);
  });

  it("is for a super admin and for product or vendor managers, and no one else", async () => {
    const o = await oneReview();
    const staff = (title: string, email: string) => asUser(o.admin.bearer).post("/admin/staff", { name: "Some Manager", email, phone: "08031234567", password: "Passw0rdTest", role: "STAFF", staffTitle: title });
    await staff("PRODUCT_MANAGER", "product@example.com");
    await staff("FINANCE_MANAGER", "finance@example.com");
    expect((await asUser(await loginToken("product@example.com")).get("/admin/reviews")).status).toBe(200);
    expect((await asUser(await loginToken("product@example.com")).post(`/admin/reviews/${o.made.id}/approve`)).status).toBe(200);
    expect((await asUser(await loginToken("finance@example.com")).get("/admin/reviews")).status).toBe(403);
    expect((await asUser(await loginToken("finance@example.com")).get("/admin/reviews/counts")).status).toBe(403);
    expect((await asUser(await loginToken("finance@example.com")).post(`/admin/reviews/${o.made.id}/approve`)).status).toBe(403);
    expect((await asUser(await loginToken("finance@example.com")).delete(`/admin/reviews/${o.made.id}`)).status).toBe(403);
    expect((await o.c.get("/admin/reviews")).status).toBe(403);
    expect((await o.c.post(`/admin/reviews/${o.made.id}/approve`)).status).toBe(403);
    expect((await api().get("/api/admin/reviews")).status).toBe(401);
    expect(await Review.countDocuments()).toBe(1);
  });
});
