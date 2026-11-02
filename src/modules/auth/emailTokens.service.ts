import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../../utils/AppError.js";
import { EmailToken, type EmailTokenPurpose } from "../../models/EmailToken.js";
import { User, type UserDoc } from "../../models/User.js";
import { getNotifier } from "../../services/notifications/index.js";
import { hashPassword } from "./auth.service.js";

// Confirming an email address and resetting a password both work the same way: a long random link goes to the person's
// inbox, and following it proves they can read that inbox. The link is one-use and short-lived, only its hash is stored,
// and it is sent by email only (never written to the in-app notifications, which other staff screens can read).

const HOUR = 3_600_000;
export const VERIFY_TTL_MS = 24 * HOUR;
export const RESET_TTL_MS = 1 * HOUR;
/** Asking for another email sooner than this after the last one is refused, so the button cannot be used to flood an inbox. */
export const RESEND_COOLDOWN_MS = 60_000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const recipient = (u: UserDoc) => ({ id: String(u._id), name: u.name, email: u.email });

/** Makes a new link for the person and cancels any earlier unused one for the same purpose. Returns the raw token (sent, never stored). */
async function issueToken(userId: UserDoc["_id"], purpose: EmailTokenPurpose, ttlMs: number, now = new Date()): Promise<string> {
  await EmailToken.deleteMany({ userId, purpose, usedAt: { $exists: false } });
  const token = randomBytes(32).toString("base64url");
  await EmailToken.create({ userId, purpose, tokenHash: hash(token), expiresAt: new Date(now.getTime() + ttlMs) });
  return token;
}

/** Spends a link. Atomic, so two clicks (or two tabs) cannot both use it. Returns the person it belongs to, or null if it is wrong, used or expired. */
async function consumeToken(token: string, purpose: EmailTokenPurpose, now = new Date()) {
  const spent = await EmailToken.findOneAndUpdate(
    { tokenHash: hash(token), purpose, usedAt: { $exists: false }, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { returnDocument: "after" },
  );
  return spent ? User.findById(spent.userId) : null;
}

const invalidLink = () => new AppError(400, "INVALID_TOKEN", "This link is invalid or has expired. Please ask for a new one.");

/** Emails the "confirm your address" link. Never throws: a mail problem must not stop a sign-up. */
export async function sendVerificationEmail(user: UserDoc): Promise<void> {
  try {
    const token = await issueToken(user._id, "VERIFY_EMAIL", VERIFY_TTL_MS);
    await getNotifier().notify(
      [recipient(user)],
      {
        kind: "VERIFY_EMAIL",
        title: "Welcome to VendraMart: confirm your email",
        body: "Thanks for joining. Please confirm that this is your email address, so we can send you order updates and help you get back in if you forget your password.\n\nThe link works for 24 hours and can be used once. If you did not create this account, you can ignore this email.",
        link: `/verify-email/?token=${token}`,
        cta: "Confirm my email",
      },
      { channels: "external" },
    );
  } catch (err) {
    console.error("Could not send the verification email:", (err as Error).message);
  }
}

export async function verifyEmail(token: string, now = new Date()): Promise<UserDoc> {
  const user = await consumeToken(token, "VERIFY_EMAIL", now);
  if (!user) throw invalidLink();
  if (!user.emailVerified) {
    user.emailVerified = true;
    user.emailVerifiedAt = now;
    await user.save();
  }
  return user;
}

/** A signed-in person asks for another confirmation email. */
export async function resendVerification(user: UserDoc, now = new Date()): Promise<{ alreadyVerified: boolean }> {
  if (user.emailVerified) return { alreadyVerified: true };
  const last = await EmailToken.findOne({ userId: user._id, purpose: "VERIFY_EMAIL" }).sort({ createdAt: -1 });
  if (last && now.getTime() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new AppError(429, "RATE_LIMITED", "We sent one a moment ago. Please check your inbox, or wait a minute and try again.");
  }
  await sendVerificationEmail(user);
  return { alreadyVerified: false };
}

/**
 * "Forgot password". Always looks the same from outside, whether or not the address has an account, so it cannot be used to
 * find out who is registered. Only active accounts get a link.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await User.findOne({ email });
  if (!user || !user.isActive) return;
  try {
    const token = await issueToken(user._id, "RESET_PASSWORD", RESET_TTL_MS);
    await getNotifier().notify(
      [recipient(user)],
      {
        kind: "RESET_PASSWORD",
        title: "Reset your VendraMart password",
        body: "We got a request to reset the password on your account. Use the button to choose a new one. The link works for 1 hour and can be used once.\n\nIf you did not ask for this, you can ignore this email and your password stays as it is.",
        link: `/reset-password/?token=${token}`,
        cta: "Choose a new password",
      },
      { channels: "external" },
    );
  } catch (err) {
    console.error("Could not send the password reset email:", (err as Error).message);
  }
}

export async function resetPassword(token: string, newPassword: string, now = new Date()): Promise<void> {
  const user = await consumeToken(token, "RESET_PASSWORD", now);
  if (!user || !user.isActive) throw invalidLink();
  user.passwordHash = await hashPassword(newPassword);
  // They received the link in their inbox, so that address is theirs.
  if (!user.emailVerified) {
    user.emailVerified = true;
    user.emailVerifiedAt = now;
  }
  await user.save();
  // Any other reset link still out there is cancelled.
  await EmailToken.deleteMany({ userId: user._id, purpose: "RESET_PASSWORD", usedAt: { $exists: false } });
  try {
    await getNotifier().notify(
      [recipient(user)],
      {
        kind: "PASSWORD_CHANGED",
        title: "Your VendraMart password was changed",
        body: "The password on your account was just changed. If that was you, there is nothing more to do.\n\nIf it was not you, reset your password again now and contact us on the number in the footer of the website.",
        link: "/forgot-password/",
        cta: "Reset my password",
      },
      { channels: "external" },
    );
  } catch (err) {
    console.error("Could not send the password changed email:", (err as Error).message);
  }
}
