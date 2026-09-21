import { NextRequest, NextResponse } from "next/server";
import { hashSessionToken, SESSION_COOKIE } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) await prisma.userSession.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
  const response = NextResponse.json({ success: true });
  response.cookies.set({ name: SESSION_COOKIE, value: "", httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", expires: new Date(0), path: "/" });
  return response;
}
