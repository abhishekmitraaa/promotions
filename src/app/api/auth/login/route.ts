import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSessionToken, hashSessionToken, SESSION_COOKIE, verifyPassword } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = await checkRateLimit(`login:${ip}`, 10, 15 * 60 * 1000);
  if (!rl.success) return NextResponse.json({ success: false, error: { code: "RATE_LIMITED", message: "Too many login attempts. Try again later." } }, { status: 429 });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }, { status: 400 }); }
  const email = typeof (body as any)?.email === "string" ? (body as any).email.trim().toLowerCase() : "";
  const password = typeof (body as any)?.password === "string" ? (body as any).password : "";
  if (!email || !password) return NextResponse.json({ success: false, error: { code: "VALIDATION_ERROR", message: "Email and password are required" } }, { status: 400 });

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
