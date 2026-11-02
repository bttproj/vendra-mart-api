import nodemailer, { type Transporter } from "nodemailer";
import { env, isTest, primaryClientOrigin } from "../../config/env.js";
import { Notification } from "../../models/Notification.js";
import { renderEmail } from "./emailTemplate.js";
import type { NotificationChannel, NotificationMessage, Recipient } from "./NotificationService.js";

/** Shows up in the bell inside the app. */
export class InAppChannel implements NotificationChannel {
  readonly name = "in-app";
  async send(to: Recipient, m: NotificationMessage) {
    await Notification.create({ userId: to.id, kind: m.kind, title: m.title, body: m.body, link: m.link });
  }
}

const DEFAULT_FROM = "VendraMart <no-reply@vendramart.test>";

/** What every email channel sends for one notification: a subject, a branded HTML body and a plain-text copy. */
function composeEmail(to: Recipient, m: NotificationMessage) {
  const url = m.link ? `${primaryClientOrigin}${m.link}` : primaryClientOrigin;
  const { html, text } = renderEmail({ name: to.name, title: m.title, body: m.body, url, origin: primaryClientOrigin, ctaLabel: m.cta });
  return { subject: m.title, html, text, ...(m.replyTo ? { replyTo: m.replyTo } : {}) };
}

/**
 * Email through SMTP when SMTP_HOST is configured. Without it (development, tests) nothing is sent: the
 * message is printed to the console instead, so the flow can be seen without any mail account.
 */
export class EmailChannel implements NotificationChannel {
  readonly name = "email";
  private transport: Transporter;
  private live: boolean;

  constructor() {
    this.live = Boolean(env.SMTP_HOST);
    this.transport = this.live
      ? nodemailer.createTransport({
          host: env.SMTP_HOST,
          port: Number(env.SMTP_PORT ?? 587),
          secure: Number(env.SMTP_PORT) === 465,
          auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
        })
      : nodemailer.createTransport({ jsonTransport: true });
  }

  async send(to: Recipient, m: NotificationMessage) {
    await this.transport.sendMail({ from: env.EMAIL_FROM ?? DEFAULT_FROM, to: to.email, ...composeEmail(to, m) });
    if (!this.live && !isTest) console.log(`[email not sent, no email service configured] to ${to.email}: ${m.title}`);
  }
}

/** Resend names the reply address `reply_to`. */
function resendBody(from: string, to: Recipient, m: NotificationMessage) {
  const { replyTo, ...mail } = composeEmail(to, m);
  return { from, to: [to.email], ...mail, ...(replyTo ? { reply_to: replyTo } : {}) };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Email through Resend (https://resend.com), used when RESEND_API_KEY is set. It talks to Resend's web address directly
 * rather than through an extra package. The sender (EMAIL_FROM) must be on a domain verified in your Resend account.
 */
export class ResendChannel implements NotificationChannel {
  readonly name = "email";

  constructor(
    private apiKey: string,
    private from: string = DEFAULT_FROM,
    private fetchImpl: FetchLike = fetch,
    private timeoutMs = 10_000,
  ) {}

  async send(to: Recipient, m: NotificationMessage) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(resendBody(this.from, to, m)),
      });
    } catch {
      throw new Error("Resend could not be reached");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // Resend explains what is wrong (for example an unverified sender domain). That goes to the log, never to a shopper.
      const reason = ((await res.json().catch(() => null)) as { message?: string } | null)?.message;
      throw new Error(`Resend refused the email (${res.status}${reason ? `: ${String(reason).slice(0, 160)}` : ""})`);
    }
  }
}

/** Resend when it has a key, otherwise SMTP, otherwise the console. */
export function pickEmailChannel(opts: { resendKey?: string; from?: string } = { resendKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }): NotificationChannel {
  return opts.resendKey ? new ResendChannel(opts.resendKey, opts.from ?? DEFAULT_FROM) : new EmailChannel();
}
