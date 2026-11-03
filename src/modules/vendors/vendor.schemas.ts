import { z } from "zod";
import { email, latLng, password, phone } from "../../utils/zodCommon.js";

const text = (min: number, max: number, msg: string) => z.string().trim().min(min, msg).max(max);

const bank = z.object({
  bankName: text(2, 80, "Enter your bank name"),
  // Nigerian bank account numbers (NUBAN) are exactly 10 digits.
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{10}$/, "Account number must be 10 digits"),
  accountName: text(2, 120, "Enter the account name"),
});

const pickup = z.object({
  line: text(5, 300, "Pick your pickup address on the map"),
  placeId: z.string().trim().max(300).optional(),
  ...latLng,
});

export const nin = z
  .string()
  .trim()
  .regex(/^[0-9]{11}$/, "NIN must be exactly 11 digits");

export const registerVendorSchema = z.object({
  ownerName: text(2, 120, "Enter the owner's full name"),
  email,
  phone,
  password,
  businessName: text(2, 120, "Enter your business name"),
  description: z.string().trim().max(600).optional(),
  // CAC registration is optional per the workflow doc.
  cacNumber: z
    .string()
    .trim()
    .max(30)
    .regex(/^[A-Za-z0-9/-]*$/, "CAC number can only have letters, numbers, / and -")
    .optional()
    .transform((v) => (v ? v : undefined)),
  pickup,
  bank,
  // Required or optional depending on the admin's setting, which the service checks.
  nin: nin.optional(),
});

/** The admin creates a store for someone: the same details, but no password. The owner chooses theirs from an emailed link. */
export const adminCreateVendorSchema = registerVendorSchema.omit({ password: true }).strict();

export const updateProfileSchema = z
  .object({
    businessName: text(2, 120, "Enter your business name"),
    ownerName: text(2, 120, "Enter the owner's full name"),
    phone,
    description: z.string().trim().max(600),
    cacNumber: z
      .string()
      .trim()
      .max(30)
      .regex(/^[A-Za-z0-9/-]*$/, "CAC number can only have letters, numbers, / and -"),
  })
  .partial()
  .strict();

export const updateBankSchema = bank;
export const updateNinSchema = z.object({ nin }).strict();
export const updatePickupSchema = pickup;

export const suspendSchema = z.object({ reason: text(3, 300, "Give a short reason") });

export type RegisterVendorInput = z.infer<typeof registerVendorSchema>;
