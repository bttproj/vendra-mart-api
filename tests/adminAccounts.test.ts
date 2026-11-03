import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Notification } from "../src/models/Notification.js";
import { User } from "../src/models/User.js";
import { PASSWORD, api, clearDb, createCustomer, createUser, createVendor, loginToken, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin, createHandler, emailLog } from "./fulfilmentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  emailLog.reset();
});

const body = (over: Record<string, unknown> = {}) => ({ name: "Kemi Boss", email: "kemi@example.com", phone: "08051112222", password: "Passw0rd123", role: "ADMIN", ...over });

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("creating another administrator", () => {
  it("makes an administrator who signs in, lands on /admin, and can use the admin area", async () => {
    const first = await createAdmin("boss@example.com");
    const res = await asUser(first.bearer).post("/admin/staff", body());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ role: "ADMIN", email: "kemi@example.com", isActive: true, isYou: false });
    expect(res.body.data.activeDeliveries).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|Passw0rd123/);

    const made = (await User.findOne({ email: "kemi@example.com" }))!;
    expect(made.role).toBe("ADMIN");
    expect(String(made.createdBy)).toBe(String(first.user._id));
    expect(made.emailVerified).toBe(true);

    const login = await api().post("/api/auth/login").send({ email: "kemi@example.com", password: "Passw0rd123" });
    expect(login.body.data).toMatchObject({ home: "/admin", user: { role: "ADMIN" } });
    const bearer = `Bearer ${login.body.data.token}`;
    expect((await asUser(bearer).get("/admin/staff")).status).toBe(200);
    expect((await asUser(bearer).get("/admin/overview")).status).toBe(200);
  });

  it("emails the new administrator that the account exists, without the password, and not through the in-app bell", async () => {
    const first = await createAdmin("boss@example.com");
    await asUser(first.bearer).post("/admin/staff", body());
    await waitFor(() => emailLog.to("kemi@example.com").length === 1);
    const mail = emailLog.to("kemi@example.com")[0]!;
    expect(mail).toMatchObject({ kind: "STAFF_ACCOUNT", title: "Your VendraMart administrator account is ready", link: "/login/", cta: "Sign in" });
    expect(mail.body).toContain("Forgot your password?");
    expect(JSON.stringify(mail)).not.toContain("Passw0rd123");
    expect(await Notification.countDocuments({ kind: "STAFF_ACCOUNT" })).toBe(0);
  });

  it("tells every other administrator, but not the one who did it or the new one", async () => {
    const first = await createAdmin("boss@example.com");
    const second = await createAdmin("second@example.com");
    const sleeper = await createAdmin("off@example.com");
    await User.updateOne({ _id: sleeper.user._id }, { isActive: false });
    await asUser(first.bearer).post("/admin/staff", body());
    await waitFor(() => emailLog.to("second@example.com").length === 1);

    const notice = emailLog.to("second@example.com")[0]!;
    expect(notice).toMatchObject({ kind: "ADMIN_ADDED", title: "A new administrator was added", link: "/admin/staff/" });
    expect(notice.body).toContain("ADMIN User added Kemi Boss (kemi@example.com)");
    expect(await waitFor(async () => (await Notification.countDocuments({ userId: second.user._id, kind: "ADMIN_ADDED" })) === 1)).toBe(true);

    expect(emailLog.to("boss@example.com").some((m) => m.kind === "ADMIN_ADDED")).toBe(false);
    expect(emailLog.to("kemi@example.com").some((m) => m.kind === "ADMIN_ADDED")).toBe(false);
    expect(emailLog.to("off@example.com")).toHaveLength(0);
  });

  it("adding a handler does not alert the administrators", async () => {
    const first = await createAdmin("boss@example.com");
    await createAdmin("second@example.com");
    await asUser(first.bearer).post("/admin/staff", body({ role: "HANDLER", email: "rider@example.com" }));
    await waitFor(() => emailLog.to("rider@example.com").length === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(emailLog.sent.some((s) => s.message.kind === "ADMIN_ADDED")).toBe(false);
    expect(emailLog.to("rider@example.com")[0]!.title).toBe("Your VendraMart delivery account is ready");
  });

  it("only an administrator can do it: not a handler, customer or vendor, and not a visitor", async () => {
    const v = await createVendor({ email: "v@example.com" });
    const c = await createCustomer();
    const h = await createHandler();
    for (const bearer of [h.bearer, c.bearer, await loginToken(v.email)]) {
      expect((await asUser(bearer).post("/admin/staff", body())).status).toBe(403);
    }
    expect((await api().post("/api/admin/staff").send(body())).status).toBe(401);
    expect(await User.countDocuments({ email: "kemi@example.com" })).toBe(0);
  });

  it("refuses a duplicate email, whatever role it is for", async () => {
    const first = await createAdmin("boss@example.com");
    await createUser("CUSTOMER", "taken@example.com");
    const a = asUser(first.bearer);
    expect((await a.post("/admin/staff", body({ email: "taken@example.com" }))).status).toBe(409);
    expect((await a.post("/admin/staff", body({ email: "boss@example.com", role: "HANDLER" }))).status).toBe(409);
  });
});

describe("the staff list", () => {
  it("shows administrators first, marks which one is you, and gives handlers their workload", async () => {
    const first = await createAdmin("boss@example.com");
    await createHandler("rider@example.com");
    const a = asUser(first.bearer);
    await a.post("/admin/staff", body());
    const list = (await a.get("/admin/staff")).body.data as { role: string; email: string; isYou: boolean; activeDeliveries?: number }[];
    expect(list.map((m) => m.role)).toEqual(["ADMIN", "ADMIN", "HANDLER"]);
    expect(list.filter((m) => m.isYou).map((m) => m.email)).toEqual(["boss@example.com"]);
    expect(list.find((m) => m.email === "rider@example.com")!.activeDeliveries).toBe(0);
    expect(list.find((m) => m.role === "ADMIN")!.activeDeliveries).toBeUndefined();
    expect(JSON.stringify(list)).not.toMatch(/passwordHash/);
  });

  it("never lists customers or vendors", async () => {
    const first = await createAdmin("boss@example.com");
    await createCustomer();
    await createVendor();
    const list = (await asUser(first.bearer).get("/admin/staff")).body.data as { role: string }[];
    expect(list.every((m) => m.role === "ADMIN" || m.role === "HANDLER")).toBe(true);
    expect(list).toHaveLength(1);
  });
});

describe("switching an administrator off", () => {
  it("an administrator can deactivate another, who is locked out at once, and can switch them back on", async () => {
    const first = await createAdmin("boss@example.com");
    const second = await createAdmin("second@example.com");
    const a = asUser(first.bearer);
    expect((await asUser(second.bearer).get("/admin/staff")).status).toBe(200);

    const off = await a.patch(`/admin/staff/${second.user._id}`, { isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.data).toMatchObject({ role: "ADMIN", isActive: false });
    expect((await asUser(second.bearer).get("/admin/staff")).status).toBe(401);
    expect((await api().post("/api/auth/login").send({ email: "second@example.com", password: PASSWORD })).status).toBe(403);

    expect((await a.patch(`/admin/staff/${second.user._id}`, { isActive: true })).status).toBe(200);
    expect((await api().post("/api/auth/login").send({ email: "second@example.com", password: PASSWORD })).status).toBe(200);
  });

  it("nobody can deactivate their own account, so the last administrator can never lock everyone out", async () => {
    const only = await createAdmin("boss@example.com");
    const res = await asUser(only.bearer).patch(`/admin/staff/${only.user._id}`, { isActive: false });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/own account/);
    expect((await User.findById(only.user._id))!.isActive).toBe(true);
    expect((await asUser(only.bearer).get("/admin/staff")).status).toBe(200);
  });

  it("can rename an administrator but never change anyone's role", async () => {
    const first = await createAdmin("boss@example.com");
    const second = await createAdmin("second@example.com");
    const a = asUser(first.bearer);
    expect((await a.patch(`/admin/staff/${second.user._id}`, { name: "Second Boss" })).body.data.name).toBe("Second Boss");
    expect((await a.patch(`/admin/staff/${second.user._id}`, { role: "CUSTOMER" })).status).toBe(422);
    expect((await a.patch(`/admin/staff/${second.user._id}`, { role: "HANDLER" })).status).toBe(422);
    expect((await User.findById(second.user._id))!.role).toBe("ADMIN");
  });

  it("an administrator account cannot be deleted from the dashboard, only switched off", async () => {
    const first = await createAdmin("boss@example.com");
    const second = await createAdmin("second@example.com");
    const a = asUser(first.bearer);
    for (const path of ["customers", "staff"]) {
      expect((await api().delete(`/api/admin/${path}/${second.user._id}`).set("Authorization", first.bearer)).status).toBe(404);
    }
    expect(await User.findById(second.user._id)).not.toBeNull();
  });
});
