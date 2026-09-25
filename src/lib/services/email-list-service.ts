/**
 * Email List & Membership Management Service
 *
 * Implements tenant-scoped audience lists and memberships:
 * - Create, update, rename, and archive lists
 * - Enforce strict tenant isolation on list membership operations
 *   (Tenant A cannot add Tenant B's contacts to a list)
 * - Prevent duplicate list memberships
 * - Bulk membership add and remove operations
 */

import { prisma } from "../prisma";
import { EmailList, EmailListMember, EmailSubscriptionStatus } from "@prisma/client";

export class EmailListService {
  /**
   * Creates a new audience list for a tenant.
   */
  static async createList(
    clientId: string,
    name: string,
    description?: string | null
  ): Promise<EmailList> {
    if (!clientId) throw new Error("clientId is required");
    const cleanName = name?.trim();
    if (!cleanName) throw new Error("List name is required");

    const existing = await prisma.emailList.findUnique({
      where: {
        clientId_name: {
          clientId,
          name: cleanName,
        },
      },
    });

    if (existing) {
      throw new Error(`List '${cleanName}' already exists for this tenant.`);
    }

    return prisma.emailList.create({
      data: {
        clientId,
        name: cleanName,
        description: description?.trim() || null,
        active: true,
      },
    });
  }

  /**
   * Retrieves a list by ID strictly scoped to tenant.
   */
  static async getListById(
    clientId: string,
    listId: string
  ): Promise<(EmailList & { memberCount: number }) | null> {
    if (!clientId || !listId) return null;
    const list = await prisma.emailList.findFirst({
      where: { id: listId, clientId },
      include: {
        _count: {
          select: {
            members: {
              where: { status: EmailSubscriptionStatus.SUBSCRIBED },
            },
          },
        },
      },
    });

    if (!list) return null;

    const { _count, ...rest } = list;
    return {
      ...rest,
      memberCount: _count.members,
    };
  }

  /**
   * Lists all audience lists for a tenant with active member counts.
   */
  static async listLists(
    clientId: string,
    options: { activeOnly?: boolean } = {}
  ): Promise<Array<EmailList & { memberCount: number }>> {
    if (!clientId) throw new Error("clientId is required");

    const where: Record<string, unknown> = { clientId };
    if (options.activeOnly !== false) {
      where.active = true;
    }

    const lists = await prisma.emailList.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            members: {
              where: { status: EmailSubscriptionStatus.SUBSCRIBED },
            },
          },
        },
      },
    });

    return lists.map(({ _count, ...list }) => ({
      ...list,
      memberCount: _count.members,
    }));
  }

  /**
   * Updates or renames an existing audience list.
   */
  static async updateList(
    clientId: string,
    listId: string,
    data: { name?: string; description?: string | null; active?: boolean }
  ): Promise<EmailList> {
    const list = await prisma.emailList.findFirst({
      where: { id: listId, clientId },
    });

    if (!list) {
      throw new Error(`List '${listId}' not found for tenant '${clientId}'.`);
    }

    const updatePayload: Record<string, unknown> = {};

    if (data.name !== undefined) {
      const cleanName = data.name.trim();
      if (!cleanName) throw new Error("List name cannot be blank");
      if (cleanName !== list.name) {
        // Check for duplicate name
        const duplicate = await prisma.emailList.findUnique({
          where: { clientId_name: { clientId, name: cleanName } },
        });
        if (duplicate) {
          throw new Error(`List name '${cleanName}' is already taken.`);
        }
        updatePayload.name = cleanName;
      }
    }

    if (data.description !== undefined) {
      updatePayload.description = data.description?.trim() || null;
    }

    if (data.active !== undefined) {
      updatePayload.active = data.active;
    }

    return prisma.emailList.update({
      where: { id: list.id },
      data: updatePayload,
    });
  }

  /**
   * Archives a list (sets active = false).
   */
  static async archiveList(clientId: string, listId: string): Promise<EmailList> {
    return this.updateList(clientId, listId, { active: false });
  }

  /**
   * Deletes a list permanently.
   */
  static async deleteList(clientId: string, listId: string): Promise<{ deleted: boolean }> {
    const list = await prisma.emailList.findFirst({
      where: { id: listId, clientId },
    });

    if (!list) {
      throw new Error(`List '${listId}' not found for tenant '${clientId}'.`);
    }

    await prisma.emailList.delete({
      where: { id: list.id },
    });

    return { deleted: true };
  }

  /**
   * Adds a single contact to a list with strict tenant ownership validation.
   */
  static async addMember(
    clientId: string,
    listId: string,
    contactId: string
  ): Promise<EmailListMember> {
    const list = await prisma.emailList.findFirst({
      where: { id: listId, clientId },
    });
    if (!list) {
      throw new Error(`List '${listId}' not found for tenant '${clientId}'.`);
    }

    // Verify contact belongs to the same tenant!
    const contact = await prisma.emailContact.findFirst({
      where: { id: contactId, clientId },
    });
    if (!contact) {
      throw new Error(`Contact '${contactId}' does not belong to tenant '${clientId}'.`);
    }

    const existingMember = await prisma.emailListMember.findUnique({
      where: {
        listId_contactId: {
          listId,
          contactId,
        },
      },
    });

    if (existingMember) {
      if (existingMember.status === EmailSubscriptionStatus.SUBSCRIBED) {
        return existingMember; // Idempotent return without duplicate error
      }
      // Re-activate member
      return prisma.emailListMember.update({
        where: { id: existingMember.id },
        data: {
          status: EmailSubscriptionStatus.SUBSCRIBED,
          unsubscribedAt: null,
        },
      });
    }

    return prisma.emailListMember.create({
      data: {
        listId,
        contactId,
        status: EmailSubscriptionStatus.SUBSCRIBED,
      },
    });
  }

  /**
   * Removes a contact from a list (marks UNSUBSCRIBED or removes record).
   */
  static async removeMember(
    clientId: string,
    listId: string,
    contactId: string
  ): Promise<EmailListMember> {
    const list = await prisma.emailList.findFirst({
      where: { id: listId, clientId },
    });
    if (!list) {
      throw new Error(`List '${listId}' not found for tenant '${clientId}'.`);
    }

    const existingMember = await prisma.emailListMember.findUnique({
      where: {
        listId_contactId: {
          listId,
          contactId,
        },
      },
    });

    if (!existingMember) {
      throw new Error(`Contact '${contactId}' is not a member of list '${listId}'.`);
    }

    return prisma.emailListMember.update({
      where: { id: existingMember.id },
      data: {
        status: EmailSubscriptionStatus.UNSUBSCRIBED,
        unsubscribedAt: new Date(),
      },
    });
  }

  /**
   * Bulk updates list membership (adds and removes contacts).
   */
  static async bulkUpdateMembers(
    clientId: string,
    listId: string,
    options: {
      addContactIds?: string[];
      removeContactIds?: string[];
    }
  ): Promise<{ added: number; removed: number; errors: string[] }> {
    const list = await prisma.emailList.findFirst({
      where: { id: listId, clientId },
    });
    if (!list) {
      throw new Error(`List '${listId}' not found for tenant '${clientId}'.`);
    }

    let added = 0;
    let removed = 0;
    const errors: string[] = [];

    // Add members
    if (options.addContactIds && options.addContactIds.length > 0) {
      for (const cId of options.addContactIds) {
        try {
          await this.addMember(clientId, listId, cId);
          added++;
        } catch (err) {
          errors.push(`Add contact '${cId}': ${err instanceof Error ? err.message : "Error"}`);
        }
      }
    }

    // Remove members
    if (options.removeContactIds && options.removeContactIds.length > 0) {
      for (const cId of options.removeContactIds) {
        try {
          await this.removeMember(clientId, listId, cId);
          removed++;
        } catch (err) {
          errors.push(`Remove contact '${cId}': ${err instanceof Error ? err.message : "Error"}`);
        }
      }
    }

    return { added, removed, errors };
  }

  /**
   * Retrieves members of a list with pagination.
   */
  static async getListMembers(
    clientId: string,
    listId: string,
    options: { page?: number; limit?: number; status?: EmailSubscriptionStatus } = {}
  ): Promise<{
    members: Array<EmailListMember & { contact: { id: string; email: string; firstName: string | null; lastName: string | null } }>;
    total: number;
    page: number;
    limit: number;
  }> {
    const list = await prisma.emailList.findFirst({
      where: { id: listId, clientId },
    });
    if (!list) {
      throw new Error(`List '${listId}' not found for tenant '${clientId}'.`);
    }

    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 50));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { listId };
    if (options.status) {
      where.status = options.status;
    }

    const [members, total] = await Promise.all([
      prisma.emailListMember.findMany({
        where,
        include: {
          contact: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      prisma.emailListMember.count({ where }),
    ]);

    return { members, total, page, limit };
  }
}
