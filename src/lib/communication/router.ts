/**
 * Unified Message Router Facade
 *
 * Provides a single, omnichannel dispatch interface for the platform.
 * Enforces:
 * 1. Multi-tenant boundaries and channel enablement.
 * 2. Pre-dispatch suppression and opt-out checks (e.g. EmailSuppressionService).
 * 3. Recipient address validation via channel adapters.
 * 4. Zero schema disruption: delegates directly to channel adapters without mutating tables.
 */

import { assertTenantContext, isChannelEnabledForTenant } from "./tenant";
import { communicationRegistry } from "./registry";
import {
  UnifiedMessageRequest,
  UnifiedSendResult,
} from "./types";
import { EmailSuppressionService } from "../services/email-suppression-service";

export class UnifiedMessageRouter {
  /**
   * Routes and dispatches a unified message request to the appropriate channel adapter.
   */
  static async route(request: UnifiedMessageRequest): Promise<UnifiedSendResult> {
    // 1. Tenant boundary assertion
    const tenant = assertTenantContext(request.clientId);

    // 2. Check tenant channel permissions
    if (!isChannelEnabledForTenant(tenant, request.channel)) {
      return {
        success: false,
        channel: request.channel,
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "CHANNEL_NOT_ENABLED",
          message: `Channel '${request.channel}' is not enabled for tenant '${tenant.clientId}'`,
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

    // 5. Destination syntax validation
    if (adapter.validateDestination) {
      const validation = adapter.validateDestination(destination);
      if (!validation.valid) {
        return {
          success: false,
          channel: request.channel,
          deliveryId: "",
          status: "FAILED",
          error: {
            code: "INVALID_DESTINATION",
            message: validation.error || "Invalid destination address",
            retryable: false,
            failureCategory: "INVALID_DESTINATION",
          },
        };
      }
    }

    // 6. Channel-Specific Suppression Enforcement
    if (request.channel === "EMAIL") {
      try {
        const suppCheck = await EmailSuppressionService.isSuppressed(
          tenant.clientId,
          destination
        );
        if (suppCheck.suppressed) {
          return {
            success: false,
            channel: "EMAIL",
            deliveryId: "",
            status: "FAILED",
            error: {
              code: "RECIPIENT_SUPPRESSED",
              message: `Recipient '${destination}' is suppressed for tenant '${tenant.clientId}' (reason: ${suppCheck.reason})`,
              retryable: false,
              failureCategory: "OPTED_OUT_OR_SUPPRESSED",
            },
          };
        }
      } catch (err: any) {
        // If suppression check errors out, log and continue or fail safe
        console.warn(`[UnifiedMessageRouter] Suppression check warning: ${err.message}`);
      }
    }

    // 7. Dispatch message via Adapter
    return await adapter.sendMessage({
      ...request,
      clientId: tenant.clientId,
      recipient: {
        ...request.recipient,
        destination,
      },
    });
  }

  /**
   * System-wide diagnostic health assessment across all channels.
   */
  static async getHealth() {
    return await communicationRegistry.checkAllHealth();
  }
}
