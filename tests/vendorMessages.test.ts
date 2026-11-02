import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Notification } from "../src/models/Notification.js";
import { VendorMessage } from "../src/models/VendorMessage.js";
import { ResendChannel } from "../src/services/notifications/channels.js";
import { api, clearDb, createCustomer, createVendor, loginToken, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin, createHandler, emailLog } from "./fulfilmentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  emailLog.reset();
});

const GOOD = { subject: "Your store photos", body: "Hello,\n\nPlease replace the blurry photo on Garri Ijebu.\n\nThank you." };

async function setup() {
  const admin = await createAdmin("boss@example.com");
  const v = await createVendor({ email: "shop@example.com", name: "Bodija Provisions" });
  return { admin, a: asUser(admin.bearer), v };
}

describe("who can write to a vendor", () => {
  it("only an admin: not a visitor, customer, vendor or handler", async () => {
    const { v } = await setup();
    const c = await createCustomer();
    const h = await createHandler();
    const path = `/api/admin/vendors/${v.vendor._id}/message`;
    expect((await api().post(path).send(GOOD)).status).toBe(401);
    for (const bearer of [c.bearer, h.bearer, await loginToken(v.email)]) {
      expect((await api().post(path).set("Authorization", bearer).send(GOOD)).status).toBe(403);
      expect((await api().get(`/api/admin/vendors/${v.vendor._id}/messages`).set("Authorization", bearer)).status).toBe(403);
    }
    expect(emailLog.sent).toHaveLength(0);
    expect(await VendorMessage.countDocuments()).toBe(0);
  });
});

describe("sending a message", () => {
  it("emails the store owner, with the admin as the reply address, and puts a copy in their bell", async () => {
    const { a, v } = await setup();
    const res = await a.post(`/admin/vendors/${v.vendor._id}/message`, GOOD);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ subject: GOOD.subject, body: GOOD.body, status: "SENT", sentBy: "ADMIN User", toEmail: "shop@example.com" });

    const mails = emailLog.to("shop@example.com");
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ kind: "ADMIN_MESSAGE", title: GOOD.subject, body: GOOD.body, replyTo: "boss@example.com", cta: "Open your dashboard", link: "/vendor/" });
    expect(await Notification.countDocuments({ userId: v.user._id, kind: "ADMIN_MESSAGE" })).toBe(1);
    expect(emailLog.sent).toHaveLength(1); // one email, to one person
  });

  it("goes only to that store's owner, whatever else is in the request", async () => {
    const { a, v } = await setup();
    const other = await createVendor({ email: "other@example.com" });
    expect((await a.post(`/admin/vendors/${v.vendor._id}/message`, { ...GOOD, to: "someone@else.com" })).status).toBe(422);
    expect((await a.post(`/admin/vendors/${v.vendor._id}/message`, { ...GOOD, email: "someone@else.com" })).status).toBe(422);
    expect(emailLog.sent).toHaveLength(0);

    await a.post(`/admin/vendors/${v.vendor._id}/message`, GOOD);
    expect(emailLog.to("other@example.com")).toHaveLength(0);
    expect(await Notification.countDocuments({ userId: other.user._id })).toBe(0);
  });

  it("keeps a record of what was sent, newest first", async () => {
    const { a, v } = await setup();
    await a.post(`/admin/vendors/${v.vendor._id}/message`, { subject: "First one", body: "The first message body." });
    await a.post(`/admin/vendors/${v.vendor._id}/message`, { subject: "Second one", body: "The second message body." });
    const list = await a.get(`/admin/vendors/${v.vendor._id}/messages`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((m: { subject: string }) => m.subject)).toEqual(["Second one", "First one"]);
    expect(list.body.data[0]).toMatchObject({ status: "SENT", sentBy: "ADMIN User", toEmail: "shop@example.com", error: null });
    expect(list.body.data[0].sentAt).toBeTruthy();
  });

  it("a long message is trimmed in the bell but arrives whole by email", async () => {
    const { a, v } = await setup();
    const long = "word ".repeat(400).trim();
    await a.post(`/admin/vendors/${v.vendor._id}/message`, { subject: "A long note", body: long });
    expect(emailLog.to("shop@example.com")[0]!.body).toBe(long);
    const note = (await Notification.findOne({ userId: v.user._id, kind: "ADMIN_MESSAGE" }))!;
    expect(note.body.length).toBeLessThan(long.length);
    expect(note.body.endsWith("...")).toBe(true);
  });

  it("checks the subject and the message", async () => {
    const { a, v } = await setup();
    const path = `/admin/vendors/${v.vendor._id}/message`;
    for (const bad of [
      { subject: "Hi", body: GOOD.body },
      { subject: "x".repeat(121), body: GOOD.body },
      { subject: "Two\nlines", body: GOOD.body },
      { subject: "Bad\r\nBcc: evil@example.com", body: GOOD.body },
      { subject: GOOD.subject, body: "short" },
      { subject: GOOD.subject, body: "y".repeat(5001) },
      { subject: "   ", body: GOOD.body },
      {},
    ]) {
      expect((await a.post(path, bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(422);
    }
    expect(emailLog.sent).toHaveLength(0);
    expect(await VendorMessage.countDocuments()).toBe(0);
  });

  it("says no for a store that does not exist, or an id that is not one", async () => {
    const { a } = await setup();
    expect((await a.post("/admin/vendors/507f1f77bcf86cd799439011/message", GOOD)).status).toBe(404);
    expect((await a.get("/admin/vendors/507f1f77bcf86cd799439011/messages")).status).toBe(404);
    expect((await a.post("/admin/vendors/nope/message", GOOD)).status).toBe(422);
  });
});

describe("when the email cannot be sent", () => {
  it("tells the admin, records the failure, and sends nothing to the bell", async () => {
    const { a, v } = await setup();
    emailLog.failWith = new Error("Resend refused the email (403: domain is not verified)");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await a.post(`/admin/vendors/${v.vendor._id}/message`, GOOD);
    errors.mockRestore();

    expect(res.status).toBe(502);
    expect(res.body.error.message).toContain("could not be sent");
    expect(res.body.error.message).toContain("domain is not verified");
    expect(await Notification.countDocuments({ userId: v.user._id, kind: "ADMIN_MESSAGE" })).toBe(0);

    const list = (await a.get(`/admin/vendors/${v.vendor._id}/messages`)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "FAILED", error: expect.stringContaining("domain is not verified") });

    emailLog.failWith = null;
    expect((await a.post(`/admin/vendors/${v.vendor._id}/message`, GOOD)).status).toBe(201);
    expect((await a.get(`/admin/vendors/${v.vendor._id}/messages`)).body.data.map((m: { status: string }) => m.status)).toEqual(["SENT", "FAILED"]);
  });
});

describe("the email itself", () => {
  it("goes out through Resend with the reply address set", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "e1" }), { status: 200 }));
    const channel = new ResendChannel("re_key", "VendraMart <orders@vendramart.ng>", fetchMock as never);
    await channel.send({ id: "1", name: "Bola Adeyinka", email: "shop@example.com" }, { kind: "ADMIN_MESSAGE", title: "Hello", body: "A message body here.", replyTo: "boss@example.com" });
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent).toMatchObject({ to: ["shop@example.com"], subject: "Hello", reply_to: "boss@example.com" });
    expect(sent.replyTo).toBeUndefined();
  });

  it("has no reply address when none is given, so ordinary emails are unchanged", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "e1" }), { status: 200 }));
    await new ResendChannel("re_key", undefined, fetchMock as never).send({ id: "1", name: "A B", email: "a@b.ng" }, { kind: "X", title: "T", body: "B" });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).reply_to).toBeUndefined();
  });
});

describe("deleting a store", () => {
  it("removes the messages written to it", async () => {
    const { a, v } = await setup();
    await a.post(`/admin/vendors/${v.vendor._id}/message`, GOOD);
    expect(await VendorMessage.countDocuments()).toBe(1);
    expect((await a.delete(`/admin/vendors/${v.vendor._id}`)).status).toBe(200);
    expect(await VendorMessage.countDocuments()).toBe(0);
  });
});
