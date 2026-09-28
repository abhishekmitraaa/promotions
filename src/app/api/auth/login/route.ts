import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSessionToken, hashSessionToken, SESSION_COOKIE, verifyPassword } from "@/lib/auth";
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const ipRl = await checkRateLimit(`login:${ip}`, 10, 15 * 60 * 1000, {
    criticality: "CRITICAL",
    failClosed: true,
    syncToDb: true,
  });
  if (!ipRl.success) {
    return rateLimitResponse(
      ipRl,
      "Too many login attempts from this IP address. Please try again later."
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }, { status: 400 }); }
  const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const email = typeof bodyObj.email === "string" ? bodyObj.email.trim().toLowerCase() : "";
  const password = typeof bodyObj.password === "string" ? bodyObj.password : "";
  if (!email || !password) return NextResponse.json({ success: false, error: { code: "VALIDATION_ERROR", message: "Email and password are required" } }, { status: 400 });

  // Account-level brute force protection: 25 attempts per 15 minutes per email
  const acctRl = await checkRateLimit(`rl:acct:${email}:login`, 25, 15 * 60 * 1000, {
    criticality: "CRITICAL",
    failClosed: true,
  });
  if (!acctRl.success) {
    return rateLimitResponse(
      acctRl,
      "Too many failed login attempts for this account. Please wait before trying again.",
      "ACCOUNT_RATE_LIMITED"
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.active || !(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ success: false, error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } }, { status: 401 });
  }

  const { token, expiresAt } = createSessionToken(user);
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(expiresAt) } });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const response = NextResponse.json({ success: true, data: { id: user.id, email: user.email, role: user.role } });
  response.cookies.set({ name: SESSION_COOKIE, value: token, httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", expires: new Date(expiresAt) });
  return response;
}
