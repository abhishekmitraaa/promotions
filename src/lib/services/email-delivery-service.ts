/**
 * Email Delivery Inspection Service
 *
 * Implements tenant-scoped delivery inspection and event timeline retrieval:
 * - Read-only inspection available to both ADMIN and VIEWER roles.
 * - Enforces strict tenant isolation.
 */

import { prisma } from "../prisma";
import { EmailDeliveryStatus, EmailType } from "@prisma/client";

export interface ListDeliveriesOptions {
  page?: number;
  limit?: number;
  status?: EmailDeliveryStatus;
  category?: EmailType;
  to?: string;
  campaignId?: string;
}

export class EmailDeliveryService {
  /**
   * Lists email deliveries for a tenant with filtering and pagination.
   */
  static async listDeliveries(
    clientId: string,
    options: ListDeliveriesOptions = {}
  ) {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      clientId,
    };

    if (options.status) {
      where.status = options.status;
    }
    if (options.category) {
      where.category = options.category;
    }
    if (options.to) {
      where.to = { contains: options.to.toLowerCase().trim() };
    }
    if (options.campaignId) {
      where.campaignRecipient = {
        campaignId: options.campaignId,
      };
    }

    const [total, items] = await Promise.all([
      prisma.emailDelivery.count({ where }),
      prisma.emailDelivery.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          campaignRecipient: {
            select: {
              campaignId: true,
              email: true,
            },
          },
          events: {
            select: {
              id: true,
              eventType: true,
              occurredAt: true,
              createdAt: true,
            },
            orderBy: { occurredAt: "desc" },
          },
        },
      }),
    ]);

    return {
      items,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Retrieves single delivery details and complete event history.
   */
  static async getDeliveryById(clientId: string, id: string) {
    const delivery = await prisma.emailDelivery.findFirst({
      where: { id, clientId },
      include: {
        campaignRecipient: {
          select: {
            id: true,
            campaignId: true,
            email: true,
            status: true,
          },
        },
        events: {
          orderBy: { occurredAt: "desc" },
        },
      },
    });

    if (!delivery) {
      return null;
    }

    return delivery;
  }
}
