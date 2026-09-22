import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualSecret } from "@/lib/timing-safe";

const SESSION_COOKIE = "whatsapp_hub_session";

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(normalized);
}

async function verifyToken(token: string) {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  try {
    const payload = decodeBase64Url(encoded);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sigBytes = Uint8Array.from(decodeBase64Url(signature), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(payload));
    if (!valid) return null;
    const parsed = JSON.parse(payload) as { id?: string; email?: string; role?: string; expiresAt?: number };
    if (!parsed.id || !parsed.email || !["ADMIN", "VIEWER"].includes(parsed.role || "") || typeof parsed.expiresAt !== "number" || !Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= Date.now()) return null;
    return { id: parsed.id, email: parsed.email, role: parsed.role };
  } catch { return null; }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isDashboardRoute = pathname.startsWith("/dashboard");
  const isAdminApiRoute = pathname.startsWith("/api/admin");
  const isAuthRoute = pathname.startsWith("/api/auth") || pathname === "/login";

  if (isAuthRoute) return NextResponse.next();

  if (isDashboardRoute || isAdminApiRoute) {
    const workerSecretHeader = req.headers.get("x-worker-secret");
    if (
      isAdminApiRoute &&
      pathname === "/api/admin/webhooks/process-queue" &&
      req.method === "POST" &&
      (await timingSafeEqualSecret(workerSecretHeader, process.env.INTERNAL_WORKER_SECRET))
    ) {
      return NextResponse.next();
    }

    const token = req.cookies.get(SESSION_COOKIE)?.value;
    const session = token ? await verifyToken(token) : null;

    if (!session) {
      if (isAdminApiRoute) return NextResponse.json({ success:false, error:{code:"UNAUTHORIZED",message:"Authentication required"} }, { status:401 });
      return NextResponse.redirect(new URL("/login", req.url));
    }

    if (isAdminApiRoute && req.method !== "GET" && session.role !== "ADMIN") {
      return NextResponse.json({ success:false, error:{code:"FORBIDDEN",message:"Admin role required"} }, { status:403 });
    }

    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/api/admin/:path*", "/api/auth/:path*", "/login"],
};
