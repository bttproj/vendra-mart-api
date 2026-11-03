import { z } from "zod";
import { email, password, phone } from "../../utils/zodCommon.js";

const token = z.string().trim().min(20, "This link is not valid").max(200, "This link is not valid");

export const addressInput = z.object({
  label: z.string().trim().min(1).max(40).default("Home"),
  line: z.string().trim().min(5, "Enter your delivery address").max(300),
  landmark: z.string().trim().max(200).optional(),
  placeId: z.string().trim().max(300).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const registerCustomerSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name").max(120),
  email,
  phone,
  password,
  address: addressInput,
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password").max(72),
});

export const verifyEmailSchema = z.object({ token }).strict();
export const forgotPasswordSchema = z.object({ email }).strict();
export const resetPasswordSchema = z.object({ token, password }).strict();

export const changePasswordSchema = z.object({ currentPassword: z.string().min(1, "Enter your current password").max(72), newPassword: password }).strict();

export type RegisterCustomerInput = z.infer<typeof registerCustomerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
