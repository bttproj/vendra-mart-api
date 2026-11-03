import { splitOrigins } from "./env.js";

// A start-up checklist for a live (production) server. Mistakes that would make the site insecure or silently broken stop
// the server from starting, with a plain message. Things that are merely not set up yet (payments, email, pictures) are
// listed as warnings in the log, so the site can still be deployed step by step.

/** The settings the checks look at. A plain object, so the rules can be tested without touching real settings. */
export interface CheckedSettings {
  CLIENT_ORIGIN: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN_DAYS: number;
  PAYSTACK_SECRET_KEY?: string;
  GOOGLE_MAPS_SERVER_KEY?: string;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
  RESEND_API_KEY?: string;
  SMTP_HOST?: string;
  EMAIL_FROM?: string;
  PLACEHOLDER_IMAGES?: string;
}

export interface CheckResult {
  /** Reasons the server must not start. */
  errors: string[];
  /** Things to set up before real customers use the site. */
  warnings: string[];
}

const isLocalOrigin = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(origin);

/** A secret that is obviously a stand-in: a word, a pattern, or only a few different characters. */
function looksLikePlaceholder(secret: string): boolean {
  if (/^(dev|test|change|your|secret|example|password|jwt)/i.test(secret)) return true;
  if (/(change[-_ ]?me|replace[-_ ]?me|placeholder|dev-memory|secret-test)/i.test(secret)) return true;
  return new Set(secret).size < 10;
}

export function checkProductionConfig(s: CheckedSettings): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const origin of splitOrigins(s.CLIENT_ORIGIN)) {
    if (isLocalOrigin(origin)) errors.push(`CLIENT_ORIGIN lists ${origin}, which is a development address. Set it to your website's https address (for example https://www.yourdomain.com). Until then the live site would be refused by the API.`);
    else if (!origin.startsWith("https://")) errors.push(`CLIENT_ORIGIN lists ${origin}, which is not https. A live site must use https, because sign-in tokens travel on every request.`);
  }
  if (looksLikePlaceholder(s.JWT_SECRET)) errors.push("JWT_SECRET looks like a stand-in value. Use a long random one, for example: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\" (changing it signs everyone out).");

  if (!s.PAYSTACK_SECRET_KEY) warnings.push("PAYSTACK_SECRET_KEY is not set: nobody can pay, because the stand-in payment page is switched off on a live server.");
  else if (s.PAYSTACK_SECRET_KEY.startsWith("sk_test_")) warnings.push("PAYSTACK_SECRET_KEY is a TEST key: payments will work but no real money moves. Use the sk_live_ key to take real payments.");
  if (!s.GOOGLE_MAPS_SERVER_KEY) warnings.push("GOOGLE_MAPS_SERVER_KEY is not set: delivery distances cannot be worked out, so checkout will not be able to price delivery.");
  if (!(s.CLOUDINARY_CLOUD_NAME && s.CLOUDINARY_API_KEY && s.CLOUDINARY_API_SECRET)) warnings.push("Cloudinary is not fully set (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET): picture, logo, receipt and NIN slip uploads will be refused.");
  if (!s.RESEND_API_KEY && !s.SMTP_HOST) warnings.push("No email service is set (RESEND_API_KEY or SMTP_HOST): confirmation, password reset and order emails are only written to this log, so people cannot confirm their email or reset a password.");
  else if (!s.EMAIL_FROM || /\.test>?$/i.test(s.EMAIL_FROM)) warnings.push("EMAIL_FROM is missing or still the sample address. Set it to an address on your verified sending domain, for example VendraMart <orders@yourdomain.com>.");
  if (s.PLACEHOLDER_IMAGES !== "false") warnings.push("PLACEHOLDER_IMAGES is not 'false': stand-in Unsplash photos still appear wherever a product has no picture. Set it to false for real customers.");
  if (s.JWT_EXPIRES_IN_DAYS > 30) warnings.push(`JWT_EXPIRES_IN_DAYS is ${s.JWT_EXPIRES_IN_DAYS}: a stolen sign-in token would stay usable for that long. Thirty days or fewer is safer.`);

  return { errors, warnings };
}
