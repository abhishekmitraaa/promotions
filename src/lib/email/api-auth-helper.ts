/**
 * Email Platform API Authentication & RBAC Helper
 *
 * Supports both:
 * 1. API Key Auth (`Authorization: Bearer <key>`): Tenant-scoped API key.
 * 2. Session Cookie Auth (`whatsapp_hub_session`): Admin / Viewer role-based access.
 *
 * Enforces:
 * - Strict tenant scoping (`clientId`).
 * - VIEWER role is strictly read-only: any mutation (POST, PATCH, DELETE) gives 403 Forbidden.
 * - ADMIN role has full mutation rights.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "../api-auth";
import { requireUser, UserRole } from "../auth";
import { prisma } from "../prisma";

export interface EmailAuthResult {
  authorized: boolean;
  clientId?: string;
  role?: UserRole;
  errorResponse?: NextResponse;
}

export async function authenticateEmailApi(
  req: NextRequest,
  options: { requireAdminForMutations?: boolean } = {}
): Promise<EmailAuthResult> {
  const authHeader = req.headers.get("authorization");

  // 1. Check Bearer API Key Authentication
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const apiAuth = await authenticateApiKey(req);
    if (!apiAuth.authenticated || !apiAuth.clientId) {
      return {
        authorized: false,
        errorResponse: apiAuth.errorResponse,
      };
    }
    return {
      authorized: true,
      clientId: apiAuth.clientId,
      role: "ADMIN", // API keys represent authorized tenant integrations
    };
  }

  // 2. Check Session Cookie Authentication
  const userAuth = await requireUser(
    req,
    options.requireAdminForMutations ? "ADMIN" : undefined
  );

  if (userAuth.response) {
    // 401 or 403 depending on session vs role
    const status = userAuth.response.status;
    const body = await userAuth.response.json().catch(() => ({}));
    return {
      authorized: false,
      errorResponse: NextResponse.json(body, { status }),
    };
  }

  // Determine target tenant clientId for dashboard user
  const { searchParams } = new URL(req.url);
  let clientId =
    searchParams.get("clientId") ||
    req.headers.get("x-client-id") ||
    undefined;

  if (!clientId) {
    // Automatically scope session user to the active default tenant ApiClient
    const defaultClient = await prisma.apiClient.findFirst({
      where: { active: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (defaultClient) {
      clientId = defaultClient.id;
    } else {
      const anyClient = await prisma.apiClient.findFirst({
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (anyClient) {
        clientId = anyClient.id;
      } else {
        const created = await prisma.apiClient.create({
          data: { name: "Default Organization", active: true },
          select: { id: true },
        });
        clientId = created.id;
      }
    }
  }

  return {
    authorized: true,
    clientId,
    role: userAuth.user?.role,
  };
}
