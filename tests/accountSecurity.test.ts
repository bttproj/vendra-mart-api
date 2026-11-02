import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EmailToken } from "../src/models/EmailToken.js";
import { Notification } from "../src/models/Notification.js";
import { User } from "../src/models/User.js";
import { PASSWORD, api, clearDb, createUser, customerBody, loginToken, seedReferenceData, startDb, stopDb, vendorBody } from "./helpers.js";
import { asUser, createAdmin, emailLog } from "./fulfilmentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  emailLog.reset();
});

/** Account emails are sent after the response, so wait briefly for them. */
async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

const tokenIn = (link: string | undefined) => new URL(link ?? "", "http://x").searchParams.get("token") ?? "";

async function signUp(email = "new@example.com") {
  const res = await api().post("/api/auth/register").send(customerBody({ email }));
  expect(res.status).toBe(201);
  await waitFor(() => emailLog.to(email).some((m) => m.kind === "VERIFY_EMAIL"));
  const mail = emailLog.to(email).find((m) => m.kind === "VERIFY_EMAIL")!;
  return { res, bearer: `Bearer ${res.body.data.token}`, token: tokenIn(mail.link), mail };
}

describe("confirming an email address", () => {
  it("starts unconfirmed, and the emailed link confirms it", async () => {
    const s = await signUp();
    expect(s.res.body.data.user.emailVerified).toBe(false);
    expect((await asUser(s.bearer).get("/auth/me")).body.data.user.emailVerified).toBe(false);
    expect(s.token.length).toBeGreaterThan(30);

    const res = await api().post("/api/auth/verify-email").send({ token: s.token });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ verified: true, email: "new@example.com" });
    expect((await asUser(s.bearer).get("/auth/me")).body.data.user.emailVerified).toBe(true);
    expect((await User.findOne({ email: "new@example.com" }))!.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("works from the link alone, with nobody signed in", async () => {
    const s = await signUp();
    expect((await api().post("/api/auth/verify-email").send({ token: s.token })).status).toBe(200);
  });

  it("a link works once, and a wrong, short or expired one is refused", async () => {
    const s = await signUp();
    expect((await api().post("/api/auth/verify-email").send({ token: s.token })).status).toBe(200);
    const again = await api().post("/api/auth/verify-email").send({ token: s.token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("INVALID_TOKEN");

    expect((await api().post("/api/auth/verify-email").send({ token: "x".repeat(43) })).status).toBe(400);
    expect((await api().post("/api/auth/verify-email").send({ token: "short" })).status).toBe(422);
    expect((await api().post("/api/auth/verify-email").send({})).status).toBe(422);

    const s2 = await signUp("late@example.com");
    await EmailToken.updateMany({ userId: (await User.findOne({ email: "late@example.com" }))!._id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await api().post("/api/auth/verify-email").send({ token: s2.token })).status).toBe(400);
    expect((await User.findOne({ email: "late@example.com" }))!.emailVerified).toBe(false);
  });

  it("a reset link cannot be used to confirm an address, or the other way round", async () => {
    const s = await signUp();
    await api().post("/api/auth/forgot-password").send({ email: "new@example.com" });
    await waitFor(() => emailLog.to("new@example.com").some((m) => m.kind === "RESET_PASSWORD"));
    const reset = tokenIn(emailLog.to("new@example.com").find((m) => m.kind === "RESET_PASSWORD")!.link);
    expect((await api().post("/api/auth/verify-email").send({ token: reset })).status).toBe(400);
    expect((await api().post("/api/auth/reset-password").send({ token: s.token, password: "Another1234" })).status).toBe(400);
  });

  it("stores only a hash of the link, and keeps it out of the in-app notifications", async () => {
    const s = await signUp();
    const stored = await EmailToken.find();
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(s.token);
    expect(stored[0]!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    const user = (await User.findOne({ email: "new@example.com" }))!;
    expect(JSON.stringify(await Notification.find({ userId: user._id }))).not.toContain(s.token);
  });

  it("the email is branded, says welcome, and has a button to the right place", async () => {
    const s = await signUp();
    expect(s.mail.title).toBe("Welcome to VendraMart: confirm your email");
    expect(s.mail.cta).toBe("Confirm my email");
    expect(s.mail.link).toMatch(/^\/verify-email\/\?token=/);
  });
});

describe("asking for another confirmation email", () => {
  it("sends a fresh link and cancels the old one", async () => {
    const s = await signUp();
    // createdAt cannot be changed through the model, so age the token in the collection itself.
    await EmailToken.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    emailLog.reset();
    const res = await asUser(s.bearer).post("/auth/resend-verification");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ alreadyVerified: false });
    await waitFor(() => emailLog.to("new@example.com").length === 1);
    const fresh = tokenIn(emailLog.to("new@example.com")[0]!.link);
    expect(fresh).not.toBe(s.token);
    expect((await api().post("/api/auth/verify-email").send({ token: s.token })).status).toBe(400);
    expect((await api().post("/api/auth/verify-email").send({ token: fresh })).status).toBe(200);
  });

  it("is refused if asked again within a minute", async () => {
    const s = await signUp();
    const res = await asUser(s.bearer).post("/auth/resend-verification");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });

  it("does nothing for someone already confirmed, and needs a sign-in", async () => {
    const s = await signUp();
    await api().post("/api/auth/verify-email").send({ token: s.token });
    emailLog.reset();
    const res = await asUser(s.bearer).post("/auth/resend-verification");
    expect(res.body.data).toEqual({ alreadyVerified: true });
    expect(emailLog.sent).toHaveLength(0);
    expect((await api().post("/api/auth/resend-verification")).status).toBe(401);
  });
});

describe("what needs a confirmed email", () => {
  const order = (bearer: string) =>
    api().post("/api/checkout").set("Authorization", bearer).send({ items: [{ productId: "507f1f77bcf86cd799439011", qty: 1 }], addressId: "507f1f77bcf86cd799439012" });

  it("an unconfirmed customer cannot place an order, and can once they confirm", async () => {
    const s = await signUp();
    const blocked = await order(s.bearer);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("EMAIL_NOT_VERIFIED");

    await api().post("/api/auth/verify-email").send({ token: s.token });
    expect((await order(s.bearer)).status).not.toBe(403); // it now gets as far as looking for the (made up) product
  });

  it("people and staff who existed before, or were made by an admin, count as confirmed", async () => {
    await createUser("CUSTOMER", "old@example.com");
    expect((await User.findOne({ email: "old@example.com" }))!.emailVerified).toBe(true);
    expect((await asUser(await loginToken("old@example.com")).get("/auth/me")).body.data.user.emailVerified).toBe(true);
  });

  it("a store cannot be approved until its owner has confirmed their email", async () => {
    const reg = await api().post("/api/auth/vendor/register").send(vendorBody({ email: "owner@example.com" }));
    expect(reg.status).toBe(201);
    await waitFor(() => emailLog.to("owner@example.com").some((m) => m.kind === "VERIFY_EMAIL"));
    const admin = asUser((await createAdmin()).bearer);
    const id = reg.body.data.vendor.id;

    expect((await admin.get(`/admin/vendors/${id}`)).body.data.ownerEmailVerified).toBe(false);
    const refused = await admin.post(`/admin/vendors/${id}/approve`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("EMAIL_NOT_VERIFIED");

    const token = tokenIn(emailLog.to("owner@example.com").find((m) => m.kind === "VERIFY_EMAIL")!.link);
    await api().post("/api/auth/verify-email").send({ token });
    expect((await admin.get(`/admin/vendors/${id}`)).body.data.ownerEmailVerified).toBe(true);
    expect((await admin.post(`/admin/vendors/${id}/approve`)).status).toBe(200);
  });
});

describe("forgot password", () => {
  it("emails a reset link to a real account, and says the same thing to an unknown address", async () => {
    await createUser("CUSTOMER", "tolu@example.com");
    const known = await api().post("/api/auth/forgot-password").send({ email: "tolu@example.com" });
    const unknown = await api().post("/api/auth/forgot-password").send({ email: "ghost@example.com" });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);

    await waitFor(() => emailLog.to("tolu@example.com").length === 1);
    expect(emailLog.to("tolu@example.com")[0]).toMatchObject({ kind: "RESET_PASSWORD", title: "Reset your VendraMart password", cta: "Choose a new password" });
    expect(emailLog.to("tolu@example.com")[0]!.link).toMatch(/^\/reset-password\/\?token=/);
    expect(emailLog.to("ghost@example.com")).toHaveLength(0);
  });

  it("sends nothing to a deactivated account, and refuses a bad address", async () => {
    const u = await createUser("CUSTOMER", "off@example.com");
    await User.updateOne({ _id: u._id }, { isActive: false });
    expect((await api().post("/api/auth/forgot-password").send({ email: "off@example.com" })).status).toBe(200);
    expect((await api().post("/api/auth/forgot-password").send({ email: "not an email" })).status).toBe(422);
    await new Promise((r) => setTimeout(r, 150));
    expect(emailLog.sent).toHaveLength(0);
  });

  async function requestLink(email: string) {
    emailLog.reset();
    await api().post("/api/auth/forgot-password").send({ email });
    await waitFor(() => emailLog.to(email).some((m) => m.kind === "RESET_PASSWORD"));
    return tokenIn(emailLog.to(email).find((m) => m.kind === "RESET_PASSWORD")!.link);
  }

  it("sets the new password, ends the old one, tells the person, and works only once", async () => {
    await createUser("CUSTOMER", "tolu@example.com");
    const token = await requestLink("tolu@example.com");
    emailLog.reset();

    const res = await api().post("/api/auth/reset-password").send({ token, password: "BrandNew1234" });
    expect(res.status).toBe(200);
    expect((await api().post("/api/auth/login").send({ email: "tolu@example.com", password: "BrandNew1234" })).status).toBe(200);
    expect((await api().post("/api/auth/login").send({ email: "tolu@example.com", password: PASSWORD })).status).toBe(401);

    await waitFor(() => emailLog.to("tolu@example.com").some((m) => m.kind === "PASSWORD_CHANGED"));
    expect(emailLog.to("tolu@example.com").find((m) => m.kind === "PASSWORD_CHANGED")).toMatchObject({ title: "Your VendraMart password was changed" });

    const reuse = await api().post("/api/auth/reset-password").send({ token, password: "Another1234x" });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe("INVALID_TOKEN");
  });

  it("enforces the same password rules, and keeps the link usable after a mistake", async () => {
    await createUser("CUSTOMER", "tolu@example.com");
    const token = await requestLink("tolu@example.com");
    expect((await api().post("/api/auth/reset-password").send({ token, password: "short" })).status).toBe(422);
    expect((await api().post("/api/auth/reset-password").send({ token, password: "alllettersnonumber" })).status).toBe(422);
    expect((await api().post("/api/auth/reset-password").send({ token, password: "GoodOne1234" })).status).toBe(200);
  });

  it("only the newest link works, and an expired one does not", async () => {
    await createUser("CUSTOMER", "tolu@example.com");
    const first = await requestLink("tolu@example.com");
    const second = await requestLink("tolu@example.com");
    expect((await api().post("/api/auth/reset-password").send({ token: first, password: "BrandNew1234" })).status).toBe(400);

    await EmailToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    expect((await api().post("/api/auth/reset-password").send({ token: second, password: "BrandNew1234" })).status).toBe(400);
    expect((await api().post("/api/auth/login").send({ email: "tolu@example.com", password: PASSWORD })).status).toBe(200);
  });

  it("proves the inbox is theirs, so an unconfirmed address becomes confirmed", async () => {
    const s = await signUp();
    expect((await User.findOne({ email: "new@example.com" }))!.emailVerified).toBe(false);
    const token = await requestLink("new@example.com");
    await api().post("/api/auth/reset-password").send({ token, password: "BrandNew1234" });
    expect((await User.findOne({ email: "new@example.com" }))!.emailVerified).toBe(true);
    expect(s.token).toBeTruthy();
  });

  it("a deactivated account cannot reset its way back in", async () => {
    const u = await createUser("CUSTOMER", "tolu@example.com");
    const token = await requestLink("tolu@example.com");
    await User.updateOne({ _id: u._id }, { isActive: false });
    expect((await api().post("/api/auth/reset-password").send({ token, password: "BrandNew1234" })).status).toBe(400);
  });
});

describe("other emails the system sends", () => {
  it("tells a new delivery handler their account exists, without a password in it", async () => {
    const admin = asUser((await createAdmin()).bearer);
    const res = await admin.post("/admin/staff", { name: "Femi Rider", email: "rider@example.com", phone: "08051112222", password: "Passw0rd123" });
    expect(res.status).toBe(201);
    await waitFor(() => emailLog.to("rider@example.com").length === 1);
    const mail = emailLog.to("rider@example.com")[0]!;
    expect(mail).toMatchObject({ kind: "STAFF_ACCOUNT", link: "/login/" });
    expect(JSON.stringify(mail)).not.toContain("Passw0rd123");
    expect(await Notification.countDocuments({ kind: "STAFF_ACCOUNT" })).toBe(0);
  });
});
