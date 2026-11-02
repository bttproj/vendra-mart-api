import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { created, ok } from "../../utils/respond.js";
import { validate } from "../../middleware/validate.js";
import { authLimiter } from "../../middleware/rateLimit.js";
import { requireAuth, signToken } from "../../middleware/auth.js";
import { publicUser, type UserDoc } from "../../models/User.js";
import { forgotPasswordSchema, loginSchema, registerCustomerSchema, resetPasswordSchema, verifyEmailSchema } from "./auth.schemas.js";
import { requestPasswordReset, resendVerification, resetPassword, sendVerificationEmail, verifyEmail } from "./emailTokens.service.js";
import { ROLE_HOME, authenticate, registerCustomer } from "./auth.service.js";
import { registerVendorSchema } from "../vendors/vendor.schemas.js";
import { registerVendor } from "../vendors/vendor.service.js";
import { notifyVendorApplied, notifyWelcome } from "../accounts/accountEvents.js";

export const authRouter = Router();

/** Who the user is and where to send them. Signing in or registering also returns the JWT, which the website keeps and sends with every request. */
const sessionPayload = (user: UserDoc) => ({ user: publicUser(user), home: ROLE_HOME[user.role] });
const signedInPayload = (user: UserDoc) => ({ token: signToken(String(user._id), user.role), ...sessionPayload(user) });

authRouter.post(
  "/register",
  authLimiter,
  validate({ body: registerCustomerSchema }),
  asyncHandler(async (req, res) => {
    const user = await registerCustomer(req.validated.body);
    void notifyWelcome(user); // never delays or breaks the sign-up
    void sendVerificationEmail(user);
    created(res, signedInPayload(user));
  }),
);

// Vendors have their own onboarding (business, pickup pin, bank). They start PENDING until the admin approves.
authRouter.post(
  "/vendor/register",
  authLimiter,
  validate({ body: registerVendorSchema }),
  asyncHandler(async (req, res) => {
    const { user, vendor } = await registerVendor(req.validated.body);
    void notifyVendorApplied(user, vendor);
    void sendVerificationEmail(user);
    created(res, { ...signedInPayload(user), vendor: { id: String(vendor._id), slug: vendor.slug, status: vendor.status } });
  }),
);

authRouter.post(
  "/login",
  authLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const user = await authenticate(req.validated.body);
    ok(res, signedInPayload(user));
  }),
);

// Confirm an email address from the link in the email. Public: the link itself is the proof.
authRouter.post(
  "/verify-email",
  authLimiter,
  validate({ body: verifyEmailSchema }),
  asyncHandler(async (req, res) => {
    const user = await verifyEmail(req.validated.body.token);
    ok(res, { verified: true, email: user.email });
  }),
);

// A signed-in person who has not confirmed their address asks for another email.
authRouter.post(
  "/resend-verification",
  authLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await resendVerification(req.user!));
  }),
);

// Forgot password: always the same answer, so it cannot be used to find out which emails have accounts.
authRouter.post(
  "/forgot-password",
  authLimiter,
  validate({ body: forgotPasswordSchema }),
  asyncHandler(async (req, res) => {
    await requestPasswordReset(req.validated.body.email);
    ok(res, { sent: true });
  }),
);

authRouter.post(
  "/reset-password",
  authLimiter,
  validate({ body: resetPasswordSchema }),
  asyncHandler(async (req, res) => {
    await resetPassword(req.validated.body.token, req.validated.body.password);
    ok(res, { reset: true });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, sessionPayload(req.user!));
  }),
);
