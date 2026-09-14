import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Protect /dashboard and /api/admin routes
  const isDashboardRoute = pathname.startsWith("/dashboard");
  const isAdminApiRoute = pathname.startsWith("/api/admin");

  if (isDashboardRoute || isAdminApiRoute) {
    const isProduction = process.env.NODE_ENV === "production";
    const rawUsername = process.env.ADMIN_USERNAME;
    const rawPassword = process.env.ADMIN_PASSWORD;

    // In production, strictly reject if admin credentials are missing or default "admin"
    if (isProduction) {
      const isMissingOrUnsafe =
        !rawUsername ||
        !rawPassword ||
        rawUsername.trim().length === 0 ||
        rawUsername.toLowerCase() === "admin" ||
        rawPassword.toLowerCase() === "admin" ||
        rawPassword.length < 12;

      if (isMissingOrUnsafe) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "MISCONFIGURED_ADMIN_AUTH",
              message:
                "Production server admin credentials are misconfigured. Explicit non-default ADMIN_USERNAME and strong ADMIN_PASSWORD (min 12 chars) are required.",
            },
          },
          { status: 500 }
        );
      }
    }

    const expectedUsername = rawUsername || "admin";
    const expectedPassword = rawPassword || "admin";

    const authHeader = req.headers.get("authorization");
    let isAuthenticated = false;

    if (authHeader && authHeader.startsWith("Basic ")) {
      try {
        const base64Credentials = authHeader.slice(6).trim();
        const credentials = atob(base64Credentials);
        const separatorIndex = credentials.indexOf(":");

        if (separatorIndex !== -1) {
          const username = credentials.substring(0, separatorIndex);
          const password = credentials.substring(separatorIndex + 1);

          if (username === expectedUsername && password === expectedPassword) {
            isAuthenticated = true;
          }
        }
      } catch {
        isAuthenticated = false;
      }
    }

    if (!isAuthenticated) {
      if (isAdminApiRoute) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "UNAUTHORIZED",
              message: "Admin authentication required. Provide valid HTTP Basic Auth credentials.",
            },
          },
          {
            status: 401,
            headers: {
              "WWW-Authenticate": 'Basic realm="WhatsApp Hub Admin API"',
            },
          }
        );
      }

      return new NextResponse("Authentication required", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="WhatsApp Hub Admin Dashboard"',
        },
      });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/api/admin/:path*"],
};
