/**
 * Email Contact Management Service
 *
 * Implements tenant-isolated recipient management:
 * - Normalized email matching and deduplication
 * - Strict separation of email verification vs marketing consent
 * - Bulk contact import with deduplication and error isolation
 * - Metadata attribute storage for segmentation
 * - Full audit timestamps for consent tracking
 */

import { prisma } from "../prisma";
import { normalizeEmail } from "../email/normalization";
import { EmailContactStatus, EmailContact } from "@prisma/client";

export interface CreateContactInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  metadata?: Record<string, unknown> | null;
  verified?: boolean;
  hasMarketingConsent?: boolean;
  consentSource?: string | null;
}

export interface UpdateContactInput {
  firstName?: string | null;
  lastName?: string | null;
  metadata?: Record<string, unknown> | null;
  verified?: boolean;
  hasMarketingConsent?: boolean;
  consentSource?: string | null;
  status?: EmailContactStatus;
}

export interface ListContactsOptions {
  page?: number;
  limit?: number;
  search?: string;
  status?: EmailContactStatus;
  listId?: string;
  verified?: boolean;
  hasMarketingConsent?: boolean;
}

export class EmailContactService {
  /**
   * Creates a new contact with normalized email matching.
   * Prevents duplicates within the same tenant.
   */
  static async createContact(clientId: string, input: CreateContactInput): Promise<EmailContact> {
    if (!clientId) throw new Error("clientId is required");
    const normalized = normalizeEmail(input.email);

    // Check if contact already exists for this tenant
    const existing = await prisma.emailContact.findUnique({
      where: {
        clientId_normalizedEmail: {
          clientId,
          normalizedEmail: normalized,
        },
      },
    });

    if (existing) {
      throw new Error(`Contact with email '${normalized}' already exists for this tenant.`);
    }

    const consentGiven = input.hasMarketingConsent === true;

    return prisma.emailContact.create({
      data: {
        clientId,
        email: input.email.trim(),
        normalizedEmail: normalized,
        firstName: input.firstName?.trim() || null,
        lastName: input.lastName?.trim() || null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        verified: input.verified === true,
        hasMarketingConsent: consentGiven,
        consentTimestamp: consentGiven ? new Date() : null,
        consentSource: consentGiven ? (input.consentSource || "MANUAL") : null,
        status: consentGiven ? EmailContactStatus.SUBSCRIBED : EmailContactStatus.PENDING,
      },
    });
  }

  /**
   * Bulk imports contacts for a tenant.
   * Handles normalization, internal batch deduplication, and database insertion.
   */
  static async importContacts(
    clientId: string,
    contacts: CreateContactInput[]
  ): Promise<{
    imported: number;
    updated: number;
    skipped: number;
    errors: string[];
    contacts: EmailContact[];
  }> {
    if (!clientId) throw new Error("clientId is required");
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return { imported: 0, updated: 0, skipped: 0, errors: ["No contacts provided"], contacts: [] };
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];
    const savedContacts: EmailContact[] = [];
    const seenEmailsInBatch = new Set<string>();

    for (let index = 0; index < contacts.length; index++) {
      const item = contacts[index];
      try {
        if (!item.email) {
          errors.push(`Row ${index + 1}: Missing email`);
          skipped++;
          continue;
        }

        const normalized = normalizeEmail(item.email);
        if (seenEmailsInBatch.has(normalized)) {
          errors.push(`Row ${index + 1}: Duplicate email '${normalized}' within import batch`);
          skipped++;
          continue;
        }
        seenEmailsInBatch.add(normalized);

        const existing = await prisma.emailContact.findUnique({
          where: {
            clientId_normalizedEmail: {
              clientId,
              normalizedEmail: normalized,
            },
          },
        });

        const consentGiven = item.hasMarketingConsent === true;

        if (existing) {
          // Update existing contact metadata & consent if provided
          const updatedRecord = await prisma.emailContact.update({
            where: { id: existing.id },
            data: {
              firstName: item.firstName?.trim() || existing.firstName,
              lastName: item.lastName?.trim() || existing.lastName,
              metadata: item.metadata ? JSON.stringify(item.metadata) : existing.metadata,
              verified: item.verified !== undefined ? item.verified : existing.verified,
              hasMarketingConsent: item.hasMarketingConsent !== undefined ? item.hasMarketingConsent : existing.hasMarketingConsent,
              consentTimestamp: consentGiven ? (existing.consentTimestamp || new Date()) : existing.consentTimestamp,
              consentSource: item.consentSource || existing.consentSource,
            },
          });
          savedContacts.push(updatedRecord);
          updated++;
        } else {
          // Create new record
          const created = await prisma.emailContact.create({
            data: {
              clientId,
              email: item.email.trim(),
              normalizedEmail: normalized,
              firstName: item.firstName?.trim() || null,
              lastName: item.lastName?.trim() || null,
              metadata: item.metadata ? JSON.stringify(item.metadata) : null,
              verified: item.verified === true,
              hasMarketingConsent: consentGiven,
              consentTimestamp: consentGiven ? new Date() : null,
              consentSource: consentGiven ? (item.consentSource || "IMPORT") : null,
              status: consentGiven ? EmailContactStatus.SUBSCRIBED : EmailContactStatus.PENDING,
            },
          });
          savedContacts.push(created);
          imported++;
        }
      } catch (err) {
        errors.push(`Row ${index + 1} (${item.email}): ${err instanceof Error ? err.message : "Validation error"}`);
        skipped++;
      }
    }

    return { imported, updated, skipped, errors, contacts: savedContacts };
  }

  /**
   * Retrieves a contact by ID strictly scoped to tenant.
   */
  static async getContactById(clientId: string, id: string): Promise<EmailContact | null> {
    if (!clientId || !id) return null;
    return prisma.emailContact.findFirst({
      where: { id, clientId },
      include: {
        listMemberships: {
          include: {
            list: {
              select: { id: true, name: true, active: true },
            },
          },
        },
      },
    });
  }

  /**
   * Retrieves a contact by email strictly scoped to tenant.
   */
  static async getContactByEmail(clientId: string, email: string): Promise<EmailContact | null> {
    if (!clientId || !email) return null;
    const normalized = normalizeEmail(email);
    return prisma.emailContact.findUnique({
      where: {
        clientId_normalizedEmail: {
          clientId,
          normalizedEmail: normalized,
        },
      },
    });
  }

  /**
   * Updates contact fields with proper consent audit tracking.
   */
  static async updateContact(
    clientId: string,
    id: string,
    data: UpdateContactInput
  ): Promise<EmailContact> {
    const existing = await this.getContactById(clientId, id);
    if (!existing) {
      throw new Error(`Contact '${id}' not found for tenant '${clientId}'.`);
    }

    const updatePayload: Record<string, unknown> = {};

    if (data.firstName !== undefined) updatePayload.firstName = data.firstName?.trim() || null;
    if (data.lastName !== undefined) updatePayload.lastName = data.lastName?.trim() || null;
    if (data.metadata !== undefined) {
      updatePayload.metadata = data.metadata ? JSON.stringify(data.metadata) : null;
    }
    if (data.status !== undefined) updatePayload.status = data.status;

    // Consent separation handling
    if (data.hasMarketingConsent !== undefined) {
      updatePayload.hasMarketingConsent = data.hasMarketingConsent;
      if (data.hasMarketingConsent === true && !existing.hasMarketingConsent) {
        updatePayload.consentTimestamp = new Date();
        updatePayload.consentSource = data.consentSource || "MANUAL_UPDATE";
        updatePayload.unsubscribedAt = null;
        updatePayload.unsubscribeReason = null;
        updatePayload.status = EmailContactStatus.SUBSCRIBED;
      } else if (data.hasMarketingConsent === false && existing.hasMarketingConsent) {
        updatePayload.unsubscribedAt = new Date();
        updatePayload.unsubscribeReason = "MANUAL_REVOCATION";
        updatePayload.status = EmailContactStatus.UNSUBSCRIBED;
      }
    }

    // Verification separation handling: verification alone does NOT alter marketing consent!
    if (data.verified !== undefined) {
      updatePayload.verified = data.verified;
    }

    return prisma.emailContact.update({
      where: { id: existing.id },
      data: updatePayload,
    });
  }

  /**
   * Verifies contact email without changing marketing consent status.
   */
  static async verifyContact(clientId: string, id: string): Promise<EmailContact> {
    const existing = await this.getContactById(clientId, id);
    if (!existing) {
      throw new Error(`Contact '${id}' not found for tenant '${clientId}'.`);
    }

    return prisma.emailContact.update({
      where: { id: existing.id },
      data: {
        verified: true,
        // hasMarketingConsent remains exactly as it was!
      },
    });
  }

  /**
   * Deactivates or archives a contact.
   */
  static async archiveContact(clientId: string, id: string): Promise<EmailContact> {
    const existing = await this.getContactById(clientId, id);
    if (!existing) {
      throw new Error(`Contact '${id}' not found for tenant '${clientId}'.`);
    }

    return prisma.emailContact.update({
      where: { id: existing.id },
      data: {
        status: EmailContactStatus.UNSUBSCRIBED,
        hasMarketingConsent: false,
        unsubscribedAt: new Date(),
        unsubscribeReason: "CONTACT_ARCHIVED",
      },
    });
  }

  /**
   * Deletes a contact permanently (cascading list memberships).
   */
  static async deleteContact(clientId: string, id: string): Promise<{ deleted: boolean }> {
    const existing = await this.getContactById(clientId, id);
    if (!existing) {
      throw new Error(`Contact '${id}' not found for tenant '${clientId}'.`);
    }

    await prisma.emailContact.delete({
      where: { id: existing.id },
    });

    return { deleted: true };
  }

  /**
   * Lists contacts with pagination and flexible filters.
   */
  static async listContacts(
    clientId: string,
    options: ListContactsOptions = {}
  ): Promise<{
    contacts: EmailContact[];
    total: number;
    page: number;
    limit: number;
  }> {
    if (!clientId) throw new Error("clientId is required");

    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 50));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { clientId };

    if (options.status) where.status = options.status;
    if (options.verified !== undefined) where.verified = options.verified;
    if (options.hasMarketingConsent !== undefined) where.hasMarketingConsent = options.hasMarketingConsent;

    if (options.search) {
      const q = options.search.trim().toLowerCase();
      where.OR = [
        { normalizedEmail: { contains: q } },
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
      ];
    }

    if (options.listId) {
      where.listMemberships = {
        some: {
          listId: options.listId,
        },
      };
    }

    const [contacts, total] = await Promise.all([
      prisma.emailContact.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.emailContact.count({ where }),
    ]);

    return { contacts, total, page, limit };
  }
}
