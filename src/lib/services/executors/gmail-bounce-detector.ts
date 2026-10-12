/**
 * GmailBounceDetector
 *
 * Gmail has no delivery webhooks: a bounce arrives as a mailer-daemon message in the sending
 * mailbox. This scans that mailbox and records each bounce as an EmailEvent, so the normal
 * event pipeline (delivery state machine, hard-bounce suppression, campaign metrics) applies.
 *
 * - Opt-in: GMAIL_BOUNCE_DETECTION=true, and the provider must have granted gmail.readonly
 *   (recorded in EmailProviderConfig.configMetadata.grantedScopes at OAuth time).
 * - Idempotent: the event id is derived from the Gmail message id.
 * - Anyone can email the mailbox, so a notice is trusted only if ALL of these hold:
 *     1. it is in the Gmail thread of a delivery this tenant actually sent,
 *     2. the failed address equals that delivery's recipient,
 *     3. its From address is a mailer-daemon / postmaster mailbox (exact local part, not a display name).
 *   Anything else is ignored, so a forged notice cannot suppress an arbitrary address.
 * - Spam complaints are not available from the Gmail API and are not detected.
 */

import { prisma } from "../../prisma";
import { EmailEventType, EmailProviderStatus, EmailProviderType } from "@prisma/client";
import { GmailProvider } from "../../email/providers/gmail/gmail-provider";
import { normalizeEmail } from "../../email/normalization";
import { EmailEventService } from "../email-event-service";
import { BounceClassification } from "../../email/webhooks/types";
import { redactSecrets } from "../../crypto";
import { logger } from "../../logger";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const GMAIL_MESSAGES_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const BOUNCE_QUERY = "from:(mailer-daemon OR postmaster) newer_than:3d";
const HARD_BOUNCE_PATTERN =
  /address (couldn't be|could not be|not) found|does(n't| not) exist|no such (user|recipient|mailbox)|unknown (user|recipient)|user unknown|invalid (recipient|address)|domain .*(not found|doesn't exist)|\b5\.1\.[1-3]\b|\b550\b/i;

export function isGmailBounceDetectionEnabled(): boolean {
  return process.env.GMAIL_BOUNCE_DETECTION === "true";
}

export interface GmailBounceScanReport {
  enabled: boolean;
  providersChecked: number;
  providersSkipped: number;
  bouncesRecorded: number;
  errors: string[];
  durationMs: number;
}

export interface GmailBounceScanOptions {
  fetchFn?: typeof fetch;
  maxMessagesPerProvider?: number;
  isTimeExhausted?: () => boolean;
}

interface GmailMessageMetadata {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
}

function grantedScopes(configMetadata: string | null): string[] {
  if (!configMetadata) return [];
  try {
    const scopes = (JSON.parse(configMetadata) as { grantedScopes?: unknown }).grantedScopes;
    return Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** True when the From header's actual address (not its display name) is a bounce sender. */
function isBounceSender(fromHeader: string | undefined): boolean {
  if (!fromHeader) return false;
  const address = (fromHeader.match(/<([^>]+)>/)?.[1] || fromHeader).trim().toLowerCase();
  return /^(mailer-daemon|postmaster)@[a-z0-9.-]+$/.test(address);
}

function header(message: GmailMessageMetadata, name: string): string | undefined {
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

export class GmailBounceDetector {
  static async run(options: GmailBounceScanOptions = {}): Promise<GmailBounceScanReport> {
    const startTime = Date.now();
    const report: GmailBounceScanReport = {
      enabled: isGmailBounceDetectionEnabled(),
      providersChecked: 0,
      providersSkipped: 0,
      bouncesRecorded: 0,
      errors: [],
      durationMs: 0,
    };
    if (!report.enabled) return report;

    const fetchFn = options.fetchFn || fetch;
    const maxMessages = Math.min(100, Math.max(1, options.maxMessagesPerProvider || 25));

    const configs = await prisma.emailProviderConfig.findMany({
      where: {
        providerType: EmailProviderType.GMAIL,
        status: EmailProviderStatus.ACTIVE,
        encryptedCredentials: { not: null },
      },
      select: { id: true, clientId: true, encryptedCredentials: true, configMetadata: true },
    });

    for (const config of configs) {
      if (options.isTimeExhausted?.()) break;
      if (!grantedScopes(config.configMetadata).includes(GMAIL_READONLY_SCOPE)) {
        report.providersSkipped++;
        continue;
      }
      report.providersChecked++;

      try {
        const provider = new GmailProvider({ encryptedCredentials: config.encryptedCredentials!, fetchFn });
        const accessToken = await provider.getAccessToken();
        const authHeaders = { Authorization: `Bearer ${accessToken}` };

        const listUrl = `${GMAIL_MESSAGES_ENDPOINT}?q=${encodeURIComponent(BOUNCE_QUERY)}&maxResults=${maxMessages}`;
        const listRes = await fetchFn(listUrl, { headers: authHeaders });
        if (!listRes.ok) {
          throw new Error(`Gmail message list failed (${listRes.status}): ${await listRes.text().catch(() => "")}`);
        }
        const listed = ((await listRes.json()) as { messages?: Array<{ id: string }> }).messages || [];

        for (const { id } of listed) {
          if (options.isTimeExhausted?.()) break;
          const eventIdPrefix = `gmail-bounce-${id}`;

          // Already recorded on an earlier scan
          const seen = await prisma.emailEvent.findFirst({
            where: { providerConfigId: config.id, providerEventId: { startsWith: eventIdPrefix } },
            select: { id: true },
          });
          if (seen) continue;

          const detailUrl = `${GMAIL_MESSAGES_ENDPOINT}/${encodeURIComponent(id)}?format=metadata&metadataHeaders=X-Failed-Recipients&metadataHeaders=Subject&metadataHeaders=From`;
          const detailRes = await fetchFn(detailUrl, { headers: authHeaders });
          if (!detailRes.ok) {
            throw new Error(`Gmail message read failed (${detailRes.status})`);
          }
          const detail = (await detailRes.json()) as GmailMessageMetadata;

          const failedRecipients = (header(detail, "X-Failed-Recipients") || "")
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean);
          if (failedRecipients.length === 0) continue; // not an attributable delivery failure
          if (!isBounceSender(header(detail, "From"))) continue; // display-name spoof or unrelated sender

          const subject = header(detail, "Subject") || "";
          if (/\(delay\)|delayed/i.test(subject) && !/failure|undeliver/i.test(subject)) continue; // Gmail is still retrying

          const snippet = (detail.snippet || "").slice(0, 300);
          const bounceType: BounceClassification = HARD_BOUNCE_PATTERN.test(snippet) ? "HARD_BOUNCE" : "SOFT_BOUNCE";
          const occurredAt = detail.internalDate ? new Date(Number(detail.internalDate)) : new Date();

          // A genuine notice is threaded with the message that bounced. Without a matching
          // delivery of this tenant the notice is untrusted and ignored.
          const delivery = detail.threadId
            ? await prisma.emailDelivery.findFirst({
                where: { clientId: config.clientId, providerMessageId: detail.threadId },
                select: { id: true, to: true },
              })
            : null;
          if (!delivery) continue;
          const deliveredTo = normalizeEmail(delivery.to);

          for (let i = 0; i < failedRecipients.length; i++) {
            // Only the address we actually sent to in this thread can be marked as bounced
            if (normalizeEmail(failedRecipients[i]) !== deliveredTo) continue;
            const result = await EmailEventService.recordAndEnqueueEvent(
              {
                providerType: EmailProviderType.GMAIL,
                providerEventId: failedRecipients.length > 1 ? `${eventIdPrefix}-${i}` : eventIdPrefix,
                eventType: EmailEventType.BOUNCED,
                recipient: deliveredTo,
                occurredAt,
                bounceType,
                bounceReason: snippet || subject,
                deliveryId: delivery.id,
                rawPayload: { source: "gmail_mailbox_scan", gmailMessageId: id, gmailThreadId: detail.threadId, subject },
              },
              { id: config.id, clientId: config.clientId }
            );
            if (result.success && !result.deduplicated) report.bouncesRecorded++;
          }
        }
      } catch (err) {
        const message = redactSecrets(err instanceof Error ? err.message : String(err));
        report.errors.push(`provider ${config.id}: ${message}`);
        logger.error(`[GmailBounceDetector] Scan failed for provider ${config.id}: ${message}`);
      }
    }

    report.durationMs = Date.now() - startTime;
    if (report.bouncesRecorded > 0) {
      logger.info(`[GmailBounceDetector] Recorded ${report.bouncesRecorded} bounce event(s) from ${report.providersChecked} mailbox(es)`);
    }
    return report;
  }
}
