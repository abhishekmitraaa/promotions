import { NextRequest, NextResponse } from "next/server";
import { prisma } from "./prisma";
import { hashApiKey } from "./crypto";

export interface AuthResult {
  authenticated: boolean;
  keyId?: string;
  clientId?: string;
  clientName?: string;
  errorResponse?: NextResponse;
}

/**
 * Authenticate incoming API request using `Authorization: Bearer <key>`.
 */
export async function authenticateApiKey(req: NextRequest): Promise<AuthResult> {
  const authHeader = req.headers.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      authenticated: false,
      errorResponse: NextResponse.json(
        {
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: "Missing or invalid Authorization header. Header format must be 'Bearer <API_KEY>'",
          },
        },
        { status: 401 }
      ),
    };
  }

  const rawKey = authHeader.substring(7).trim();

  if (!rawKey) {
    return {
      authenticated: false,
      errorResponse: NextResponse.json(
        {
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: "API key cannot be empty",
          },
        },
        { status: 401 }
      ),
    };
  }

  const keyHash = hashApiKey(rawKey);

  try {
    const apiKeyRecord = await prisma.apiKey.findUnique({
      where: { keyHash },
      include: { client: true },
    });

    if (!apiKeyRecord) {
      return {
        authenticated: false,
        errorResponse: NextResponse.json(
          {
            success: false,
            error: {
              code: "UNAUTHORIZED",
              message: "Invalid API key provided",
            },
          },
          { status: 401 }
        ),
      };
    }

    if (apiKeyRecord.revokedAt) {
      return {
        authenticated: false,
        errorResponse: NextResponse.json(
          {
            success: false,
            error: {
              code: "FORBIDDEN",
              message: "This API key has been revoked",
            },
          },
          { status: 403 }
        ),
      };
    }

    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      return {
        authenticated: false,
        errorResponse: NextResponse.json(
          {
            success: false,
            error: {
              code: "FORBIDDEN",
              message: "This API key has expired",
            },
          },
          { status: 403 }
        ),
      };
    }

    if (!apiKeyRecord.client || !apiKeyRecord.client.active) {
      return {
        authenticated: false,
        errorResponse: NextResponse.json(
          {
            success: false,
            error: {
              code: "FORBIDDEN",
              message: "The associated API client is inactive or disabled",
            },
          },
          { status: 403 }
        ),
      };
    }

    // Fire & forget update of lastUsedAt timestamp
    prisma.apiKey
      .update({
        where: { id: apiKeyRecord.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {});

    return {
      authenticated: true,
      keyId: apiKeyRecord.id,
      clientId: apiKeyRecord.client.id,
      clientName: apiKeyRecord.client.name,
    };
  } catch (err) {
    console.error("Database authentication error:", err);
    return {
      authenticated: false,
      errorResponse: NextResponse.json(
        {
          success: false,
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Authentication failure due to database error",
          },
        },
        { status: 500 }
      ),
    };
  }
}
