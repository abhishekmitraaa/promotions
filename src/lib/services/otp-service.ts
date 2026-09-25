import { prisma } from "../prisma";
import { env, isMetaConfigured } from "../env";
import { generateSecureOtp, hashOtp, normalizePhoneNumber } from "../crypto";
import { OtpStatus } from "@prisma/client";
import { MessageService } from "./message-service";
import { EmailService } from "./email-service";
import { EmailProvider } from "../email/types";
import { isValidEmail, normalizeEmail } from "../email/normalization";
import { dispatchOutgoingWebhooks } from "../webhooks/dispatcher";
import { logger } from "../logger";

export type OtpChannel = "WHATSAPP" | "EMAIL";

export interface RequestOtpOptions {
  emailSubject?: string;
  providerOverride?: EmailProvider;
}

export class OtpService {
  /**
   * Request a new OTP code sent to destination via WhatsApp or Email, scoped to an ApiClient.
   * Default channel is WHATSAPP to preserve 100% backward compatibility.
   */
  static async requestOtp(
    clientId: string,
    to: string,
    purpose: string = "login",
    channel: OtpChannel = "WHATSAPP",
    options?: RequestOtpOptions
  ) {
    if (!clientId) {
      throw new Error("clientId is required to request an OTP");
    }

    if (channel === "EMAIL") {
      if (!to || !isValidEmail(to)) {
        throw new Error(`Invalid recipient email address: '${to}'`);
      }
    } else {
      if (!to || to.trim() === "") {
        throw new Error("Recipient phone number is required");
      }
    }

    const normalizedTo = channel === "EMAIL" ? normalizeEmail(to) : normalizePhoneNumber(to);

    // Invalidate existing active OTPs for this client, destination, and purpose
    await prisma.otpVerification.updateMany({
      where: {
        clientId,
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

    // Create OTP database record bound to clientId
    const otpRecord = await prisma.otpVerification.create({
      data: {
        clientId,
        destination: normalizedTo,
        purpose,
        codeHash,
        status: OtpStatus.PENDING,
        expiresAt,
        attempts: 0,
      },
    });

    let messageStatus = "SENT";

    if (channel === "WHATSAPP") {
      // Send WhatsApp message scoped to this client
      const templateName = env.OTP_TEMPLATE_NAME;
      const templateLanguage = env.OTP_TEMPLATE_LANGUAGE;

      let dispatchResult;
      try {
        dispatchResult = await MessageService.send(
          {
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
          },
          { clientId }
        );
      } catch (sendErr) {
        await prisma.otpVerification
          .update({
            where: { id: otpRecord.id },
            data: { status: OtpStatus.FAILED },
          })
          .catch(() => {});

        logger.error("Failed to send OTP message via WhatsApp Cloud API:", sendErr);
        return {
          success: false,
          status: 502,
          error: {
            code: "OTP_DELIVERY_FAILED",
            message:
              sendErr instanceof Error
                ? sendErr.message
                : "Failed to dispatch OTP message via WhatsApp Cloud API",
          },
        };
      }

      if (dispatchResult.status === "FAILED") {
        await prisma.otpVerification
          .update({
            where: { id: otpRecord.id },
            data: { status: OtpStatus.FAILED },
          })
          .catch(() => {});

        logger.warn(`OTP dispatch failed for destination ${normalizedTo}: ${dispatchResult.errorMessage}`);
        return {
          success: false,
          status: 502,
          error: {
            code: "OTP_DELIVERY_FAILED",
            message: dispatchResult.errorMessage || "WhatsApp OTP delivery could not be initiated",
          },
        };
      }
      messageStatus = dispatchResult.status;
    } else {
      // Channel: EMAIL
      try {
        const emailSendResult = await EmailService.sendTransactional(
          {
            clientId,
            to: normalizedTo,
            templateType: "EMAIL_OTP",
            templateVariables: {
              otp_code: rawOtpCode,
              expires_in_minutes: Math.ceil(env.OTP_EXPIRY_SECONDS / 60),
              purpose,
            },
            subject: options?.emailSubject,
            transactionalReference: otpRecord.id,
          },
          { providerOverride: options?.providerOverride }
        );

        if (!emailSendResult.accepted) {
          await prisma.otpVerification
            .update({
              where: { id: otpRecord.id },
              data: { status: OtpStatus.FAILED },
            })
            .catch(() => {});

          return {
            success: false,
            status: 502,
            error: {
              code: "OTP_DELIVERY_FAILED",
              message: emailSendResult.error?.message || "Email OTP delivery could not be completed",
            },
          };
        }
        messageStatus = emailSendResult.providerStatus;
      } catch (sendErr) {
        await prisma.otpVerification
          .update({
            where: { id: otpRecord.id },
            data: { status: OtpStatus.FAILED },
          })
          .catch(() => {});

        logger.error("Failed to send OTP message via Email Provider:", sendErr);
        return {
          success: false,
          status: 502,
          error: {
            code: "OTP_DELIVERY_FAILED",
            message:
              sendErr instanceof Error
                ? sendErr.message
                : "Failed to dispatch OTP message via Email Provider",
          },
        };
      }
    }

    // Await durable webhook dispatch
    await dispatchOutgoingWebhooks(
      "otp.requested",
      {
        otpId: otpRecord.id,
        destination: normalizedTo,
        purpose,
        channel,
        expiresAt: expiresAt.toISOString(),
      },
      clientId
    ).catch((err) => {
      logger.error("Failed to dispatch otp.requested webhook:", err);
    });

    // Only return devCode when NODE_ENV !== "production" and simulated mode is active
    const isSimulatedDevMode =
      process.env.NODE_ENV !== "production" &&
      !isMetaConfigured() &&
      env.DEV_ALLOW_UNCONFIGURED_META;

    const devCode = isSimulatedDevMode ? rawOtpCode : undefined;

    return {
      success: true,
      status: 200,
      data: {
        otpId: otpRecord.id,
        destination: normalizedTo,
        purpose,
        channel,
        expiresInSeconds: env.OTP_EXPIRY_SECONDS,
        expiresAt: expiresAt.toISOString(),
        messageStatus,
        ...(devCode ? { devCodeNote: "Unconfigured in local dev mode", devCode } : {}),
      },
    };
  }

  /**
   * Verify an OTP code against active record with strict atomic concurrency protection.
   * Supports both WhatsApp phone destinations and Email destinations.
   */
  static async verifyOtp(
    clientId: string,
    to: string,
    purpose: string = "login",
    code: string,
    channel?: OtpChannel
  ) {
    if (!clientId) {
      throw new Error("clientId is required to verify an OTP");
    }

    // Auto-detect channel if omitted based on whether destination is an email
    const isEmail = channel === "EMAIL" || to.includes("@");
    const normalizedTo = isEmail ? normalizeEmail(to) : normalizePhoneNumber(to);

    const otpRecord = await prisma.otpVerification.findFirst({
      where: {
        clientId,
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
      await prisma.otpVerification.updateMany({
        where: { id: otpRecord.id, status: OtpStatus.PENDING },
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
      await prisma.otpVerification.updateMany({
        where: { id: otpRecord.id, status: OtpStatus.PENDING },
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
      // Atomic attempt increment
      const updated = await prisma.otpVerification.update({
        where: { id: otpRecord.id },
        data: {
          attempts: { increment: 1 },
        },
      });

      const nextAttempts = updated.attempts;
      const isFailed = nextAttempts >= env.OTP_MAX_ATTEMPTS;

      if (isFailed) {
        await prisma.otpVerification.updateMany({
          where: { id: otpRecord.id, status: OtpStatus.PENDING },
          data: { status: OtpStatus.FAILED },
        });
      }

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

    // Atomic conditional update: Only ONE concurrent request can transition PENDING -> VERIFIED
    const now = new Date();
    const updateResult = await prisma.otpVerification.updateMany({
      where: {
        id: otpRecord.id,
        clientId,
        status: OtpStatus.PENDING,
        attempts: { lt: env.OTP_MAX_ATTEMPTS },
        expiresAt: { gt: now },
      },
      data: {
        status: OtpStatus.VERIFIED,
        verifiedAt: now,
      },
    });

    if (updateResult.count === 0) {
      // Concurrency race: Another request completed verification or transitioned state first
      return {
        success: false,
        status: 409,
        error: {
          code: "OTP_ALREADY_USED",
          message: "This OTP code has already been verified or is no longer pending.",
        },
      };
    }

    await dispatchOutgoingWebhooks(
      "otp.verified",
      {
        otpId: otpRecord.id,
        destination: normalizedTo,
        purpose,
        channel: isEmail ? "EMAIL" : "WHATSAPP",
        verifiedAt: now.toISOString(),
      },
      clientId
    ).catch((err) => {
      logger.error("Failed to dispatch otp.verified webhook:", err);
    });

    return {
      success: true,
      status: 200,
      data: {
        verified: true,
        destination: normalizedTo,
        purpose,
        channel: isEmail ? "EMAIL" : "WHATSAPP",
        verifiedAt: now,
      },
    };
  }
}
