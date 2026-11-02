import type { Types } from "mongoose";
import { User, type UserDoc } from "../../models/User.js";
import { Vendor, type VendorDoc } from "../../models/Vendor.js";
import { Product } from "../../models/Product.js";
import { AppError } from "../../utils/AppError.js";
import { uniqueSlug } from "../../utils/slug.js";
import { hashPassword } from "../auth/auth.service.js";
import { requireActiveCityForPoint } from "../cities/cities.service.js";
import type { RegisterVendorInput } from "./vendor.schemas.js";

/** Creates the login (role VENDOR) and the store profile. New vendors start PENDING until the admin approves. */
export async function registerVendor(input: RegisterVendorInput): Promise<{ user: UserDoc; vendor: VendorDoc }> {
  if (await User.exists({ email: input.email })) {
    throw AppError.conflict("An account with this email already exists. Try signing in.");
  }
  await assertNinFree(input.nin);
  // Fail on a bad pin before creating anything.
  const city = await requireActiveCityForPoint(input.pickup, "pickup address");

  const user = await User.create({
    role: "VENDOR",
    name: input.ownerName,
    email: input.email,
    phone: input.phone,
    passwordHash: await hashPassword(input.password),
    emailVerified: false, // confirmed later, from the link emailed to them
  });

  try {
    const vendor = await Vendor.create({
      userId: user._id,
      businessName: input.businessName,
      slug: await uniqueSlug(Vendor, input.businessName),
      ownerName: input.ownerName,
      phone: input.phone,
      email: input.email,
      cacNumber: input.cacNumber,
      nin: input.nin,
      description: input.description,
      bank: input.bank,
      pickup: { ...input.pickup, cityId: city._id },
      status: "PENDING",
    });
    return { user, vendor };
  } catch (err) {
    // No login without a store behind it.
    await User.deleteOne({ _id: user._id });
    throw err;
  }
}

/** One NIN, one store. `exceptVendor` lets a vendor re-save their own. */
export async function assertNinFree(nin: string, exceptVendor?: Types.ObjectId) {
  const taken = await Vendor.exists({ nin, ...(exceptVendor ? { _id: { $ne: exceptVendor } } : {}) });
  if (taken) throw AppError.conflict("This NIN is already linked to another store. Contact support if you think this is a mistake.");
}

export async function getVendorForUser(userId: Types.ObjectId): Promise<VendorDoc> {
  const vendor = await Vendor.findOne({ userId });
  if (!vendor) throw AppError.notFound("Vendor profile not found");
  return vendor;
}

/** Moving the pickup pin can move the store to another city, so its products follow. */
export async function updatePickup(vendor: VendorDoc, pickup: { line: string; placeId?: string; lat: number; lng: number }) {
  const city = await requireActiveCityForPoint(pickup, "pickup address");
  vendor.pickup = { ...pickup, cityId: city._id } as VendorDoc["pickup"];
  await vendor.save();
  await Product.updateMany({ vendorId: vendor._id }, { cityId: city._id });
  return vendor;
}
