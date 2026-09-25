/**
 * Email Audience Resolution & Recipient Snapshot Engine
 *
 * Implements audience safety filtering and immutable snapshotting:
 * 1. Resolves candidate contacts from List and/or Segment.
 * 2. Filters out invalid email formats.
 * 3. Filters out unsubscribed contacts.
 * 4. Filters out suppressed contacts (EmailSuppression).
 * 5. Strictly enforces marketing consent for promotional sends.
 * 6. Creates immutable EmailCampaignRecipient snapshots with frozen recipient metadata.
 * 7. Calculates and updates accurate campaign audience metrics.
 */

import { prisma } from "../prisma";
import { isValidEmail } from "../email/normalization";
import { EmailSuppressionService } from "./email-suppression-service";
import { EmailSegmentService } from "./email-segment-service";
import {
  EmailContact,
  EmailContactStatus,
  EmailSubscriptionStatus,
  EmailType,
  EmailCampaignRecipient,
} from "@prisma/client";

export interface AudienceResolutionResult {
  totalAudience: number;
  eligibleCount: number;
  suppressedCount: number;
  unsubscribedCount: number;
  invalidCount: number;
  snapshotRecipients: EmailCampaignRecipient[];
}

export class EmailAudienceResolver {
  /**
   * Resolves and filters audience for preview without creating database snapshots.
   */
  static async resolvePreview(
    clientId: string,
    target: { listId?: string | null; segmentId?: string | null; type: EmailType }
  ): Promise<{
    totalAudience: number;
    eligibleCount: number;
    suppressedCount: number;
    unsubscribedCount: number;
    invalidCount: number;
  }> {
    const candidates = await this.getCandidateContacts(clientId, target);
    const { eligible, suppressedCount, unsubscribedCount, invalidCount } =
      await this.filterCandidates(clientId, candidates, target.type);

    return {
      totalAudience: candidates.length,
      eligibleCount: eligible.length,
      suppressedCount,
      unsubscribedCount,
      invalidCount,
    };
  }

  /**
   * Resolves audience, filters candidates, and persists an immutable EmailCampaignRecipient snapshot.
   */
  static async createRecipientSnapshot(
    clientId: string,
    campaign: { id: string; listId?: string | null; segmentId?: string | null; type: EmailType }
  ): Promise<AudienceResolutionResult> {
    const candidates = await this.getCandidateContacts(clientId, campaign);

    const { eligible, suppressedCount, unsubscribedCount, invalidCount } =
      await this.filterCandidates(clientId, candidates, campaign.type);

    const snapshotRecipients: EmailCampaignRecipient[] = [];

    // Create immutable snapshots in database
    for (const contact of eligible) {
      let metadataObj: Record<string, unknown> = {};
      if (contact.metadata) {
        try {
          metadataObj = JSON.parse(contact.metadata);
        } catch {
          metadataObj = {};
        }
      }

      const snapshotPayload = {
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        ...metadataObj,
      };

      try {
        const recipient = await prisma.emailCampaignRecipient.create({
          data: {
            campaignId: campaign.id,
            contactId: contact.id,
            email: contact.email,
            metadataSnapshot: JSON.stringify(snapshotPayload),
            status: "PENDING",
          },
        });
        snapshotRecipients.push(recipient);
      } catch {
        // If recipient was already snapshotted, continue
      }
    }

    // Update campaign total recipients
    await prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: { totalRecipients: snapshotRecipients.length },
    });

    return {
      totalAudience: candidates.length,
      eligibleCount: snapshotRecipients.length,
      suppressedCount,
      unsubscribedCount,
      invalidCount,
      snapshotRecipients,
    };
  }

  /**
   * Loads candidate contacts from specified list and/or segment.
   */
  private static async getCandidateContacts(
    clientId: string,
    target: { listId?: string | null; segmentId?: string | null }
  ): Promise<EmailContact[]> {
    const contactMap = new Map<string, EmailContact>();

    // 1. Resolve from audience list
    if (target.listId) {
      const listMembers = await prisma.emailListMember.findMany({
        where: {
          listId: target.listId,
          status: EmailSubscriptionStatus.SUBSCRIBED,
          list: { clientId },
        },
        include: { contact: true },
      });

      for (const m of listMembers) {
        if (m.contact && m.contact.clientId === clientId) {
          contactMap.set(m.contact.normalizedEmail, m.contact);
        }
      }
    }

    // 2. Resolve from audience segment
    if (target.segmentId) {
      const segment = await prisma.emailSegment.findFirst({
        where: { id: target.segmentId, clientId },
      });

      if (segment) {
        const criteria = JSON.parse(segment.criteria);
        const allContacts = await prisma.emailContact.findMany({
          where: { clientId },
        });

        for (const contact of allContacts) {
          if (EmailSegmentService.evaluateContact(criteria, contact)) {
            contactMap.set(contact.normalizedEmail, contact);
          }
        }
      }
    }

    // If neither listId nor segmentId provided, return empty
    return Array.from(contactMap.values());
  }

  /**
   * Strict marketing safety filtering pipeline:
   * Removes invalid addresses, unsubscribed contacts, suppressed recipients, and checks promotional consent.
   */
  private static async filterCandidates(
    clientId: string,
    candidates: EmailContact[],
    campaignType: EmailType
  ): Promise<{
    eligible: EmailContact[];
    suppressedCount: number;
    unsubscribedCount: number;
    invalidCount: number;
  }> {
    const eligible: EmailContact[] = [];
    let suppressedCount = 0;
    let unsubscribedCount = 0;
    let invalidCount = 0;

    for (const contact of candidates) {
      // 1. Email structure validity
      if (!isValidEmail(contact.email)) {
        invalidCount++;
        continue;
      }

      // 2. Marketing consent check for promotional sends
      if (campaignType === EmailType.PROMOTIONAL) {
        if (contact.hasMarketingConsent !== true || contact.status !== EmailContactStatus.SUBSCRIBED) {
          unsubscribedCount++;
          continue;
        }
      }

      // 3. Suppression check (check against tenant suppression list)
      const supp = await EmailSuppressionService.isSuppressed(clientId, contact.email);
      if (supp.suppressed) {
        suppressedCount++;
        continue;
      }

      eligible.push(contact);
    }

    return {
      eligible,
      suppressedCount,
      unsubscribedCount,
      invalidCount,
    };
  }
}
