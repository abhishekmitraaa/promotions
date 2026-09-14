import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Protect /dashboard and /api/admin routes
  const isDashboardRoute = pathname.startsWith("/dashboard");
  const isAdminApiRoute = pathname.startsWith("/api/admin");

  if (isDashboardRoute || isAdminApiRoute) {
    const authHeader = req.headers.get("authorization");
    const expectedUsername = process.env.ADMIN_USERNAME || "admin";
    const expectedPassword = process.env.ADMIN_PASSWORD || "admin";

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
