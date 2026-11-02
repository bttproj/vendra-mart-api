export interface NotificationMessage {
  /** Machine-readable type, e.g. ORDER_PAID. */
  kind: string;
  title: string;
  body: string;
  /** App path the message points at, e.g. /vendor/orders. */
  link?: string;
  /** Words on the button in an email. Default "Open VendraMart". */
  cta?: string;
  /** Where a reply to the email goes (an admin writing to a vendor, for example). */
  replyTo?: string;
}

/** What happened to each send, for the few callers that must tell a person whether it worked. */
export interface SendReport {
  ok: boolean;
  failures: { channel: string; to: string; message: string }[];
}

/**
 * Which channels to use. "external" is email (and any later SMS) without the in-app bell, for messages that must not be
 * stored where staff screens can read them, such as a link that signs someone in. "in-app" is the bell only.
 */
export interface NotifyOptions {
  channels?: "all" | "external" | "in-app";
}

export interface Recipient {
  id: string;
  name: string;
  email: string;
}

/** One way of reaching a person: in the app, by email, later SMS. */
export interface NotificationChannel {
  readonly name: string;
  send(to: Recipient, message: NotificationMessage): Promise<void>;
}

/**
 * Sends one message to many people over every configured channel. A channel that fails (SMTP down,
 * bad address) is logged and skipped: it must never break the order action that triggered it, and one
 * failing channel must not stop the others.
 */
export class NotificationService {
  constructor(private channels: NotificationChannel[]) {}

  async notify(recipients: Recipient[], message: NotificationMessage, options: NotifyOptions = {}): Promise<void> {
    const report = await this.send(recipients, message, options);
    for (const f of report.failures) console.error(`Notification via ${f.channel} to ${f.to} failed:`, f.message);
  }

  /** The same sending, but it says what failed instead of only logging it. For an action where a person needs to know. */
  async send(recipients: Recipient[], message: NotificationMessage, { channels = "all" }: NotifyOptions = {}): Promise<SendReport> {
    const seen = new Set<string>();
    const unique = recipients.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
    const chosen = this.channels.filter((c) => (channels === "all" ? true : channels === "in-app" ? c.name === "in-app" : c.name !== "in-app"));
    const jobs = unique.flatMap((to) => chosen.map((c) => ({ to, c })));
    const results = await Promise.allSettled(jobs.map(({ to, c }) => c.send(to, message)));
    const failures = results.flatMap((r, i) => (r.status === "rejected" ? [{ channel: jobs[i]!.c.name, to: jobs[i]!.to.id, message: (r.reason as Error)?.message ?? String(r.reason) }] : []));
    return { ok: failures.length === 0, failures };
  }
}
