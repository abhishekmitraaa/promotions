import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

const SESSION_COOKIE = "whatsapp_hub_session";

function verifyToken(token: string) {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  try {
    const payload = Buffer.from(encoded, "base64url").toString("utf8");
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    if (signature !== expected) return null;
    const [id, email, role, expiresText] = payload.split(".");
    const expiresAt = Number(expiresText);
    if (!id || !email || !["ADMIN","VIEWER"].includes(role) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    return { id, email, role };
  } catch { return null; }
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isDashboardRoute = pathname.startsWith("/dashboard");
  const isAdminApiRoute = pathname.startsWith("/api/admin");
  const isAuthRoute = pathname.startsWith("/api/auth") || pathname === "/login";

  if (isAuthRoute) return NextResponse.next();

  if (isDashboardRoute || isAdminApiRoute) {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    const session = token ? verifyToken(token) : null;

    if (!session) {
      if (isAdminApiRoute) return NextResponse.json({ success:false, error:{code:"UNAUTHORIZED",message:"Authentication required"} }, { status:401 });
      return NextResponse.redirect(new URL("/login", req.url));
    }

    if (isAdminApiRoute && req.method !== "GET" && session.role !== "ADMIN") {
      return NextResponse.json({ success:false, error:{code:"FORBIDDEN",message:"Admin role required"} }, { status:403 });
    }

    const response = NextResponse.next();
    response.headers.set("x-auth-user-id", session.id);
    response.headers.set("x-auth-role", session.role);
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/api/admin/:path*", "/api/auth/:path*", "/login"],
};
