/**
 * Unified Message Router Facade
 *
 * Provides a single, omnichannel dispatch interface for the platform.
 * Enforces:
 * 1. Multi-tenant boundaries and channel enablement.
 * 2. Pre-dispatch suppression and opt-out checks with strict FAIL-CLOSED semantics.
 *    (Never dispatches promotional communications if suppression status cannot be verified).
 * 3. Recipient address validation via channel adapters.
 * 4. Zero schema disruption: delegates directly to authoritative channel adapters.
 */

import { assertTenantContext, isChannelEnabledForTenant } from "./tenant";
import { communicationRegistry } from "./registry";
import {
  ChannelType,
  UnifiedMessageRequest,
  UnifiedSendResult,
  UnifiedProviderHealthResult,
} from "./types";
import { EmailSuppressionService } from "../services/email-suppression-service";
import { normalizePhoneNumber } from "../crypto";

export class UnifiedMessageRouter {
  /**
   * Routes and dispatches a unified message request to the appropriate channel adapter.
   */
  static async route(request: UnifiedMessageRequest): Promise<UnifiedSendResult> {
    // 1. Tenant boundary assertion
    assertTenantContext(request, "UnifiedMessageRequest");
    const clientId = request.clientId;

    // 2. Check tenant channel permissions
    if (!isChannelEnabledForTenant(clientId, request.channel)) {
      return {
        success: false,
        channel: request.channel,
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "CHANNEL_NOT_ENABLED",
          message: `Channel '${request.channel}' is not enabled for tenant '${clientId}'`,
          retryable: false,
          failureCategory: "AUTHENTICATION_FAILED",
        },
      };
    }

    // 3. Resolve Channel Adapter
    const adapter = communicationRegistry.getAdapter(request.channel);

    // 4. Resolve destination
    const destination =
      request.recipient.destination ||
      (request.channel === "WHATSAPP" || request.channel === "SMS"
        ? request.recipient.phone
        : request.channel === "EMAIL"
        ? request.recipient.email
        : request.recipient.deviceToken);

    if (!destination) {
      return {
        success: false,
        channel: request.channel,
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "MISSING_RECIPIENT_DESTINATION",
          message: `Recipient destination is missing for channel '${request.channel}'`,
          retryable: false,
          failureCategory: "INVALID_DESTINATION",
        },
      };
    }

    // 5. Destination syntax and reachability validation
    const reachability = await adapter.checkReachability(destination);
    if (!reachability.valid) {
      return {
        success: false,
        channel: request.channel,
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "INVALID_DESTINATION",
          message: reachability.reason || "Invalid destination address",
          retryable: false,
          failureCategory: "INVALID_DESTINATION",
        },
      };
    }

    const normalizedDestination = reachability.normalizedDestination || destination;

    // 6. Unified Suppression Enforcement (FAIL-CLOSED)
    // Production Invariant: Never dispatch when suppression state is unverified or active.
    try {
      if (request.channel === "EMAIL") {
        const suppCheck = await EmailSuppressionService.isSuppressed(
          clientId,
          normalizedDestination
        );
        if (suppCheck.suppressed) {
          return {
            success: false,
            channel: "EMAIL",
            deliveryId: "",
            status: "FAILED",
            error: {
              code: "RECIPIENT_SUPPRESSED",
              message: `Recipient '${normalizedDestination}' is suppressed for tenant '${clientId}' (reason: ${suppCheck.reason || "SUPPRESSED"})`,
              retryable: false,
              failureCategory: "OPTED_OUT_OR_SUPPRESSED",
            },
          };
        }
      } else if (request.channel === "WHATSAPP" || request.channel === "SMS") {
        // Phone-based suppression verification
        const normalizedPhone = normalizePhoneNumber(destination);
        const suppCheck = await EmailSuppressionService.isSuppressed(
          clientId,
          normalizedPhone
        );
        if (suppCheck.suppressed) {
          return {
            success: false,
            channel: request.channel,
            deliveryId: "",
            status: "FAILED",
            error: {
              code: "RECIPIENT_SUPPRESSED",
              message: `Recipient '${destination}' is suppressed for tenant '${clientId}' (reason: ${suppCheck.reason || "SUPPRESSED"})`,
              retryable: false,
              failureCategory: "OPTED_OUT_OR_SUPPRESSED",
            },
          };
        }
      }
    } catch (err: any) {
      // FAIL-CLOSED: Authoritative suppression check could not be verified
      return {
        success: false,
        channel: request.channel,
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "SUPPRESSION_CHECK_FAILED",
          message: `Authoritative suppression check failed for recipient '${destination}': ${err.message}. Dispatch blocked (fail-closed).`,
          retryable: true,
          failureCategory: "OPTED_OUT_OR_SUPPRESSED",
        },
      };
    }

    // 7. Dispatch message via Adapter
    return await adapter.send({
      ...request,
      clientId,
      recipient: {
        ...request.recipient,
        destination: normalizedDestination,
      },
    });
  }

  /**
   * System-wide diagnostic health assessment across all channels.
   */
  static async getHealth(clientId: string = "default"): Promise<Record<ChannelType, UnifiedProviderHealthResult>> {
    return await communicationRegistry.checkAllHealth(clientId);
  }
}
