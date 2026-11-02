import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Notification } from "../src/models/Notification.js";
import { User } from "../src/models/User.js";
import { Vendor } from "../src/models/Vendor.js";
import { EmailChannel, InAppChannel, ResendChannel, pickEmailChannel } from "../src/services/notifications/channels.js";
import { escapeHtml, renderEmail } from "../src/services/notifications/emailTemplate.js";
import { NotificationService } from "../src/services/notifications/index.js";
import { PASSWORD, api, clearDb, createVendor, customerBody, seedReferenceData, startDb, stopDb, vendorBody } from "./helpers.js";
import { createAdmin, emailLog, asUser } from "./fulfilmentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  emailLog.reset();
});

const ORIGIN = "http://localhost:3000";
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const RECIPIENT = { id: "507f1f77bcf86cd799439011", name: "Tolu Adeyemi", email: "tolu@example.com" };
const MESSAGE = { kind: "T", title: "Your items are ready", body: "Bodija Provisions has packed VM-10001-A.", link: "/order/?id=abc" };

describe("the email body", () => {
  const mail = renderEmail({ name: "Tolu Adeyemi", title: "Your items are ready", body: "First line.\n\nSecond paragraph\nwith a break.", url: `${ORIGIN}/order/?id=abc`, origin: ORIGIN });

  it("greets by first name, shows the logo and a button to the right page", () => {
    expect(mail.html).toContain("Hi Tolu,");
    expect(mail.html).not.toContain("Adeyemi");
    expect(mail.html).toContain(`src="${ORIGIN}/logo.png"`);
    expect(mail.html).toContain(`href="${ORIGIN}/order/?id=abc"`);
    expect(mail.html).toMatch(/Open VendraMart/);
    expect(mail.html).toContain("<p");
    expect(mail.html).toContain("Second paragraph<br>with a break.");
  });

  it("has a plain-text copy with the same words and address", () => {
    expect(mail.text).toContain("Hi Tolu,");
    expect(mail.text).toContain("First line.");
    expect(mail.text).toContain(`Open VendraMart: ${ORIGIN}/order/?id=abc`);
    expect(mail.text).not.toContain("<");
  });

  it("escapes anything that came from a person or a store, so it can never become markup", () => {
    const evil = renderEmail({ name: '<img src=x onerror="alert(1)">', title: "<script>alert(1)</script>", body: 'A "quoted" <b>bold</b> & more', url: `${ORIGIN}/?a="><script>x</script>`, origin: ORIGIN });
    expect(evil.html).not.toMatch(/<script/i);
    expect(evil.html).not.toContain("<img src=x");
    expect(evil.html).not.toContain("<b>bold</b>");
    expect(evil.html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; more");
    expect(evil.html).toContain("&quot;quoted&quot;");
    expect(escapeHtml(`'"<>&`)).toBe("&#39;&quot;&lt;&gt;&amp;");
  });

  it("copes with a name that is blank", () => {
    expect(renderEmail({ name: "  ", title: "T", body: "B", url: ORIGIN, origin: ORIGIN }).html).toContain("Hi there,");
  });

  it("uses no em dashes or en dashes in its own wording", () => {
    expect(mail.html + mail.text).not.toMatch(new RegExp("[\\u2013\\u2014]"));
  });
});

describe("sending through Resend", () => {
  it("posts to Resend with the key as a bearer token, the sender, the recipient, and an HTML and text body", async () => {
    const fetchMock = vi.fn(async () => reply(200, { id: "email_1" }));
    await new ResendChannel("re_test_key_123", "VendraMart <orders@vendramart.ng>", fetchMock as never).send(RECIPIENT, MESSAGE);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key_123");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ from: "VendraMart <orders@vendramart.ng>", to: ["tolu@example.com"], subject: "Your items are ready" });
    expect(body.html).toContain("Bodija Provisions has packed VM-10001-A.");
    expect(body.html).toContain(`${ORIGIN}/order/?id=abc`);
    expect(body.text).toContain("Hi Tolu,");
  });

  it("reports a refusal with its reason and status, and never includes the key", async () => {
    const channel = new ResendChannel("re_secret_key", "VendraMart <x@y.ng>", (async () => reply(403, { message: "The vendramart.ng domain is not verified." })) as never);
    const err = await channel.send(RECIPIENT, MESSAGE).catch((e: Error) => e);
    expect((err as Error).message).toContain("403");
    expect((err as Error).message).toContain("not verified");
    expect((err as Error).message).not.toContain("re_secret_key");
  });

  it("reports an unreachable Resend without the key, and gives up on a hang", async () => {
    const down = new ResendChannel("re_secret_key", undefined, (async () => {
      throw new Error("ECONNRESET with re_secret_key");
    }) as never);
    const downErr = (await down.send(RECIPIENT, MESSAGE).catch((e: Error) => e)) as Error;
    expect(downErr.message).toBe("Resend could not be reached");

    const hang = new ResendChannel(
      "re_secret_key",
      undefined,
      ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as never,
      30,
    );
    await expect(hang.send(RECIPIENT, MESSAGE)).rejects.toThrow("could not be reached");
  });

  it("is chosen only when a key is set; otherwise email goes through SMTP or the console", () => {
    expect(pickEmailChannel({ resendKey: "re_x", from: "A <a@b.ng>" })).toBeInstanceOf(ResendChannel);
    expect(pickEmailChannel({ resendKey: undefined })).toBeInstanceOf(EmailChannel);
    expect(pickEmailChannel({ resendKey: "" })).toBeInstanceOf(EmailChannel);
  });

  it("does not stop the in-app message when Resend is down: the failure is logged and skipped", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = await User.create({ role: "CUSTOMER", name: "Tolu Adeyemi", email: "tolu@example.com", phone: "08030000000", passwordHash: "x" });
    const service = new NotificationService([new InAppChannel(), new ResendChannel("re_k", undefined, (async () => reply(500, { message: "boom" })) as never)]);
    await expect(service.notify([{ id: String(user._id), name: user.name, email: user.email }], MESSAGE)).resolves.toBeUndefined();
    expect(await Notification.countDocuments({ userId: user._id })).toBe(1);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
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

describe("account emails", () => {
  it("welcomes a new customer in the bell, and emails them one message that welcomes them and asks them to confirm", async () => {
    const res = await api().post("/api/auth/register").send(customerBody({ email: "new@example.com" }));
    expect(res.status).toBe(201);
    expect(await waitFor(() => emailLog.to("new@example.com").length === 1)).toBe(true);
    expect(emailLog.to("new@example.com")[0]).toMatchObject({ kind: "VERIFY_EMAIL", title: expect.stringContaining("Welcome to VendraMart") });
    expect(emailLog.to("new@example.com")[0]!.link).toMatch(/^\/verify-email\/\?token=/);
    const user = (await User.findOne({ email: "new@example.com" }))!;
    expect(await waitFor(async () => (await Notification.countDocuments({ userId: user._id, kind: "WELCOME" })) === 1)).toBe(true);
  });

  it("does not let a failing email service break sign-up", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    emailLog.failWith = new Error("mail server down");
    const res = await api().post("/api/auth/register").send(customerBody({ email: "new@example.com" }));
    expect(res.status).toBe(201);
    expect(await User.countDocuments({ email: "new@example.com" })).toBe(1);
    errors.mockRestore();
  });

  it("confirms a store application to the owner and tells the admins there is one to review", async () => {
    const admin = await createAdmin();
    const res = await api().post("/api/auth/vendor/register").send(vendorBody({ email: "owner@example.com", businessName: "Kemi Spices" }));
    expect(res.status).toBe(201);

    expect(await waitFor(() => emailLog.to("owner@example.com").length === 2)).toBe(true);
    expect(emailLog.to("owner@example.com").find((m) => m.kind === "VENDOR_APPLIED")).toMatchObject({ title: "We received your store application", link: "/vendor/" });
    expect(emailLog.to("owner@example.com").some((m) => m.kind === "VERIFY_EMAIL")).toBe(true);
    expect(await waitFor(() => emailLog.to(admin.email).length === 1)).toBe(true);
    const vendor = (await Vendor.findOne({ businessName: "Kemi Spices" }))!;
    expect(emailLog.to(admin.email)[0]).toMatchObject({ title: "New store to review: Kemi Spices", link: `/admin/vendors/?id=${vendor._id}` });
  });

  it("tells a store owner when the store is approved, and when it is suspended and why", async () => {
    const admin = await createAdmin();
    const v = await createVendor({ name: "Pending Store", status: "PENDING", email: "pending@example.com" });
    const a = asUser(admin.bearer);

    expect((await a.post(`/admin/vendors/${v.vendor._id}/approve`)).status).toBe(200);
    expect(await waitFor(() => emailLog.to("pending@example.com").length === 1)).toBe(true);
    expect(emailLog.to("pending@example.com")[0]).toMatchObject({ title: "Pending Store is live on VendraMart", link: "/vendor/products/" });

    expect((await a.post(`/admin/vendors/${v.vendor._id}/suspend`, { reason: "Documents did not match" })).status).toBe(200);
    expect(await waitFor(() => emailLog.to("pending@example.com").length === 2)).toBe(true);
    const suspended = emailLog.to("pending@example.com")[1]!;
    expect(suspended.title).toBe("Pending Store has been suspended");
    expect(suspended.body).toContain("Documents did not match");
    expect(PASSWORD).toBeTruthy();
  });
});
