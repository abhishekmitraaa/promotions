import { z } from "zod";

const envSchema = z.object({
  // Server Environment
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().default("file:./dev.db"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  // Meta WhatsApp Cloud API Configuration
  META_GRAPH_API_VERSION: z.string().default("v22.0"),
  META_ACCESS_TOKEN: z.string().optional().default(""),
  META_PHONE_NUMBER_ID: z.string().optional().default(""),
  META_WABA_ID: z.string().optional().default(""),
  META_APP_SECRET: z.string().optional().default(""),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional().default(""),

  // Security & Admin Credentials
  API_KEY_PEPPER: z.string().default("default_local_dev_pepper_change_in_production_12345"),
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_PASSWORD: z.string().default("admin"),

  // OTP Configuration
  OTP_CODE_LENGTH: z.coerce.number().int().min(4).max(10).default(6),
  OTP_EXPIRY_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_TEMPLATE_NAME: z.string().default("auth_otp_code"),
  OTP_TEMPLATE_LANGUAGE: z.string().default("en_US"),

  // Optional Logging & Webhook settings
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  OUTBOUND_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  OUTBOUND_WEBHOOK_MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),

  // Development overrides
  DEV_ALLOW_UNCONFIGURED_META: z
    .string()
    .default("true")
    .transform((val) => val === "true" || val === "1"),
});

export type Env = z.infer<typeof envSchema>;

let parsedEnv: Env;

try {
  parsedEnv = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error("❌ Invalid environment variables configuration:", JSON.stringify(error.format(), null, 2));
  } else {
    console.error("❌ Failed to parse environment variables:", error);
  }
  // In development, fall back to safe default object if parsing fails completely
  parsedEnv = envSchema.parse({});
}

export const env = parsedEnv;

export function isMetaConfigured(): boolean {
  return Boolean(
    env.META_ACCESS_TOKEN &&
    env.META_PHONE_NUMBER_ID &&
    env.META_ACCESS_TOKEN.trim() !== "" &&
    env.META_PHONE_NUMBER_ID.trim() !== ""
  );
}
