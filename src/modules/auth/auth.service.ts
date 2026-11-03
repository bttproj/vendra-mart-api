import bcrypt from "bcryptjs";
import { User, type UserDoc } from "../../models/User.js";
import { Address } from "../../models/Address.js";
import { AppError } from "../../utils/AppError.js";
import { findCityForPoint } from "../cities/cities.service.js";
import type { LoginInput, RegisterCustomerInput } from "./auth.schemas.js";

const BCRYPT_ROUNDS = 12;
// Compared against when the email is unknown so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_ROUNDS);

export const hashPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS);

export async function registerCustomer(input: RegisterCustomerInput): Promise<UserDoc> {
  const existing = await User.exists({ email: input.email });
  if (existing) {
    throw AppError.conflict("An account with this email already exists. Try signing in.");
  }

  const user = await User.create({
    role: "CUSTOMER",
    name: input.name,
    email: input.email,
    phone: input.phone,
    passwordHash: await hashPassword(input.password),
    emailVerified: false, // confirmed later, from the link emailed to them
  });

  try {
    // Which city the pin falls in. A customer outside our cities can still register; checkout will
    // refuse them until their city is live (Phase 3).
    const city = await findCityForPoint({ lat: input.address.lat, lng: input.address.lng });
    await Address.create({
      userId: user._id,
      cityId: city?._id,
      label: input.address.label,
      line: input.address.line,
      landmark: input.address.landmark,
      placeId: input.address.placeId,
      location: { lat: input.address.lat, lng: input.address.lng },
      isDefault: true,
    });
  } catch (err) {
    // Do not leave an account without the address the business rules require.
    await User.deleteOne({ _id: user._id });
    throw err;
  }

  return user;
}

export async function authenticate({ email, password }: LoginInput): Promise<UserDoc> {
  const user = await User.findOne({ email }).select("+passwordHash");
  const hash = user?.passwordHash ?? DUMMY_HASH;
  const match = await bcrypt.compare(password, hash);
  if (!user || !match) throw new AppError(401, "UNAUTHENTICATED", "Incorrect email or password");
  if (!user.isActive) throw AppError.forbidden("This account has been deactivated. Contact support.");

  user.lastLoginAt = new Date();
  await user.save();
  return user;
}

/** A signed-in person changes their own password. They must know the current one, so a borrowed session cannot lock them out. */
export async function changePassword(userId: UserDoc["_id"], currentPassword: string, newPassword: string): Promise<UserDoc> {
  const user = await User.findById(userId).select("+passwordHash");
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw AppError.validation("Your current password is not right", [{ path: "currentPassword", message: "That is not your current password" }]);
  }
  if (currentPassword === newPassword) {
    throw AppError.validation("Choose a different password", [{ path: "newPassword", message: "Your new password must be different from the current one" }]);
  }
  user.passwordHash = await hashPassword(newPassword);
  await user.save();
  return user;
}

/** Where each role lands after sign in. Used by the client for redirects too. */
export const ROLE_HOME = {
  CUSTOMER: "/",
  VENDOR: "/vendor",
  ADMIN: "/admin",
  HANDLER: "/handler",
} as const;
