import { z } from "zod";

export const envSchema = z
  .object({
    // Server Environment
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z
      .string()
      .min(1, "DATABASE_URL is required")
      .refine(
        (val) => val.startsWith("postgresql://") || val.startsWith("postgres://"),
        {
          message:
            "DATABASE_URL must be a valid PostgreSQL connection string starting with postgresql:// or postgres://",
        }
      )
      .default("postgresql://localhost:5432/postgres"),
    DIRECT_URL: z.string().optional(),
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
    WEBHOOK_SECRET_ENCRYPTION_KEY: z
      .string()
      .default("default_dev_secret_encryption_key_32bytes_min_len!!"),

    // Development overrides - STRICTLY false in production
    DEV_ALLOW_UNCONFIGURED_META: z
      .union([z.string(), z.boolean()])
      .optional()
      .default("true")
      .transform((val) => val === "true" || val === "1" || val === true),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === "production") {
      // 0. Enforce valid non-fallback PostgreSQL DATABASE_URL in production
      if (
        !data.DATABASE_URL ||
        (!data.DATABASE_URL.startsWith("postgresql://") && !data.DATABASE_URL.startsWith("postgres://")) ||
        data.DATABASE_URL.includes("localhost:5432")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Production requires a valid, remote PostgreSQL DATABASE_URL connection string.",
          path: ["DATABASE_URL"],
        });
      }

      // 1. Enforce strong API_KEY_PEPPER in production
      if (
        !data.API_KEY_PEPPER ||
        data.API_KEY_PEPPER.length < 32 ||
        data.API_KEY_PEPPER.includes("default_local_dev_pepper") ||
        data.API_KEY_PEPPER.includes("replace_with_")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Production requires a strong, cryptographically random API_KEY_PEPPER with at least 32 characters. Default or placeholder peppers are forbidden.",
          path: ["API_KEY_PEPPER"],
        });
      }

      // 2. Enforce explicit non-default ADMIN_USERNAME in production
      if (
        !data.ADMIN_USERNAME ||
        data.ADMIN_USERNAME.trim().length === 0 ||
        data.ADMIN_USERNAME.toLowerCase() === "admin"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Production requires an explicit, non-default ADMIN_USERNAME. The default username 'admin' is strictly forbidden.",
          path: ["ADMIN_USERNAME"],
        });
      }

      // 3. Enforce explicit strong non-default ADMIN_PASSWORD in production
      if (
        !data.ADMIN_PASSWORD ||
        data.ADMIN_PASSWORD.length < 12 ||
        data.ADMIN_PASSWORD.toLowerCase() === "admin"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Production requires an explicit, strong ADMIN_PASSWORD (minimum 12 characters). The default password 'admin' is strictly forbidden.",
          path: ["ADMIN_PASSWORD"],
        });
      }

      // 4. Enforce strong WEBHOOK_SECRET_ENCRYPTION_KEY in production
      if (
        !data.WEBHOOK_SECRET_ENCRYPTION_KEY ||
        data.WEBHOOK_SECRET_ENCRYPTION_KEY.length < 32 ||
        data.WEBHOOK_SECRET_ENCRYPTION_KEY.includes("default_dev_secret_encryption_key") ||
        data.WEBHOOK_SECRET_ENCRYPTION_KEY.includes("replace_with_")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Production requires a strong WEBHOOK_SECRET_ENCRYPTION_KEY (at least 32 characters). Default or placeholder encryption keys are forbidden.",
          path: ["WEBHOOK_SECRET_ENCRYPTION_KEY"],
        });
      }
    }
  })
  .transform((data) => {
    if (data.NODE_ENV === "production") {
      return {
        ...data,
        DEV_ALLOW_UNCONFIGURED_META: false,
      };
    }
    return data;
  });

export type Env = z.infer<typeof envSchema>;

let parsedEnv: Env;
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

try {
  parsedEnv = envSchema.parse(process.env);
} catch (error) {
  // In production runtime, NEVER start the server with invalid environment!
  if (process.env.NODE_ENV === "production") {
    if (!isBuildPhase) {
      if (error instanceof z.ZodError) {
        console.error(
          "❌ Fatal Production Environment Error:",
          JSON.stringify(error.format(), null, 2)
        );
      } else {
        console.error("❌ Failed to parse environment variables:", error);
      }
      throw new Error(
        "Fatal: Production environment configuration validation failed. Server startup halted."
      );
    }
    // During build phase, suppress worker thread error dumps
  } else {
    // In local development, log validation errors for developer visibility
    if (error instanceof z.ZodError) {
      console.error(
        "❌ Invalid environment variables configuration:",
        JSON.stringify(error.format(), null, 2)
      );
    } else {
      console.error("❌ Failed to parse environment variables:", error);
    }
  }

  // In non-production or during build phase fallback, initialize with safe defaults
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
