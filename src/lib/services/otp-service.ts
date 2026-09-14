import { prisma } from "../prisma";
import { env, isMetaConfigured } from "../env";
import { generateSecureOtp, hashOtp, normalizePhoneNumber } from "../crypto";
import { OtpStatus } from "@prisma/client";
import { MessageService } from "./message-service";
import { checkRateLimit } from "../rate-limit";
import { dispatchOutgoingWebhooks } from "../webhooks/dispatcher";

export class OtpService {
  /**
   * Request a new OTP code sent to destination via WhatsApp.
   */
  static async requestOtp(to: string, purpose: string = "login") {
    const normalizedTo = normalizePhoneNumber(to);

    // Rate limit check: max 5 requests per destination per 5 minutes
    const rateCheck = checkRateLimit(`otp_req_${normalizedTo}_${purpose}`, 5, 300000);
    if (!rateCheck.success) {
      return {
        success: false,
        status: 429,
        error: {
          code: "TOO_MANY_REQUESTS",
          message: `Too many OTP requests for this number. Please wait ${rateCheck.resetSeconds} seconds.`,
        },
      };
    }

    // Invalidate existing active OTPs for destination and purpose
    await prisma.otpVerification.updateMany({
      where: {
        destination: normalizedTo,
        purpose,
        status: OtpStatus.PENDING,
      },
      data: {
        status: OtpStatus.EXPIRED,
      },
    });

    // Generate secure numeric OTP
    const rawOtpCode = generateSecureOtp(env.OTP_CODE_LENGTH);
    const codeHash = hashOtp(rawOtpCode, normalizedTo, purpose);
    const expiresAt = new Date(Date.now() + env.OTP_EXPIRY_SECONDS * 1000);

    // Create OTP database record
    const otpRecord = await prisma.otpVerification.create({
      data: {
        destination: normalizedTo,
        purpose,
        codeHash,
        status: OtpStatus.PENDING,
        expiresAt,
        attempts: 0,
      },
    });

    // Send WhatsApp message
    const templateName = env.OTP_TEMPLATE_NAME;
    const templateLanguage = env.OTP_TEMPLATE_LANGUAGE;

    const dispatchResult = await MessageService.send({
      to: normalizedTo,
      type: "template",
      templateName,
      templateLanguage,
      templateParameters: [
        {
          type: "body",
          parameters: [{ type: "text", text: rawOtpCode }],
        },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: rawOtpCode }],
        },
      ],
    });

    dispatchOutgoingWebhooks("otp.requested", {
      otpId: otpRecord.id,
      destination: normalizedTo,
      purpose,
      expiresAt: expiresAt.toISOString(),
    }).catch(() => {});

    // For local dev when Meta credentials are missing, expose dev code safely in response
    const devCode =
      !isMetaConfigured() && env.DEV_ALLOW_UNCONFIGURED_META ? rawOtpCode : undefined;

    return {
      success: true,
      status: 200,
      data: {
        otpId: otpRecord.id,
        destination: normalizedTo,
        purpose,
        expiresInSeconds: env.OTP_EXPIRY_SECONDS,
        expiresAt: expiresAt.toISOString(),
        messageStatus: dispatchResult.status,
        ...(devCode ? { devCodeNote: "Meta API credentials unconfigured in local dev mode", devCode } : {}),
      },
    };
  }

  /**
   * Verify an OTP code against active record.
   */
  static async verifyOtp(to: string, purpose: string = "login", code: string) {
    const normalizedTo = normalizePhoneNumber(to);

    // Rate limit check: max 10 verification attempts per destination per 5 minutes
    const rateCheck = checkRateLimit(`otp_ver_${normalizedTo}_${purpose}`, 10, 300000);
    if (!rateCheck.success) {
      return {
        success: false,
        status: 429,
        error: {
          code: "TOO_MANY_REQUESTS",
          message: `Too many verification attempts. Please wait ${rateCheck.resetSeconds} seconds.`,
        },
      };
    }

    const otpRecord = await prisma.otpVerification.findFirst({
      where: {
        destination: normalizedTo,
        purpose,
        status: OtpStatus.PENDING,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!otpRecord) {
      return {
        success: false,
        status: 400,
        error: {
          code: "INVALID_OTP",
          message: "No active pending OTP found for this destination and purpose.",
        },
      };
    }

    // Check expiry
    if (new Date() > otpRecord.expiresAt) {
      await prisma.otpVerification.update({
        where: { id: otpRecord.id },
        data: { status: OtpStatus.EXPIRED },
      });
      return {
        success: false,
        status: 400,
        error: {
          code: "OTP_EXPIRED",
          message: "The OTP code has expired. Please request a new one.",
        },
      };
    }

    // Check max attempts
    if (otpRecord.attempts >= env.OTP_MAX_ATTEMPTS) {
      await prisma.otpVerification.update({
        where: { id: otpRecord.id },
        data: { status: OtpStatus.FAILED },
      });
      return {
        success: false,
        status: 400,
        error: {
          code: "MAX_ATTEMPTS_EXCEEDED",
          message: "Maximum OTP verification attempts exceeded. Please request a new code.",
        },
      };
    }

    // Verify code hash
    const expectedHash = hashOtp(code, normalizedTo, purpose);
    const isValid = expectedHash === otpRecord.codeHash;

    if (!isValid) {
      const nextAttempts = otpRecord.attempts + 1;
      const isFailed = nextAttempts >= env.OTP_MAX_ATTEMPTS;

      await prisma.otpVerification.update({
        where: { id: otpRecord.id },
        data: {
          attempts: nextAttempts,
          status: isFailed ? OtpStatus.FAILED : OtpStatus.PENDING,
        },
      });

      return {
        success: false,
        status: 400,
        error: {
          code: "INVALID_OTP_CODE",
          message: "Invalid OTP code provided.",
          remainingAttempts: Math.max(0, env.OTP_MAX_ATTEMPTS - nextAttempts),
        },
      };
    }

    // Successful verification
    const verifiedRecord = await prisma.otpVerification.update({
      where: { id: otpRecord.id },
      data: {
        status: OtpStatus.VERIFIED,
        verifiedAt: new Date(),
      },
    });

    dispatchOutgoingWebhooks("otp.verified", {
      otpId: verifiedRecord.id,
      destination: normalizedTo,
      purpose,
      verifiedAt: verifiedRecord.verifiedAt?.toISOString(),
    }).catch(() => {});

    return {
      success: true,
      status: 200,
      data: {
        verified: true,
        destination: normalizedTo,
        purpose,
        verifiedAt: verifiedRecord.verifiedAt,
      },
    };
  }
}
