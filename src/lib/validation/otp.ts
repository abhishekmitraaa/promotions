import { z } from "zod";

export const requestOtpSchema = z.object({
  to: z
    .string()
    .min(7, "Destination phone number must be at least 7 digits")
    .max(20, "Phone number must not exceed 20 characters")
    .regex(/^[\d+\s()-]+$/, "Invalid phone number characters"),
  purpose: z.string().min(1).default("login"),
});

export const verifyOtpSchema = z.object({
  to: z
    .string()
    .min(7, "Destination phone number must be at least 7 digits")
    .max(20, "Phone number must not exceed 20 characters"),
  purpose: z.string().min(1).default("login"),
  code: z.string().min(4).max(10).regex(/^\d+$/, "OTP code must contain digits only"),
});

export type RequestOtpInput = z.infer<typeof requestOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
