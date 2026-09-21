import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPasswordForStorage, requireUser } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (auth.response) return auth.response;
  const users = await prisma.user.findMany({ select: { id: true, email: true, role: true, active: true, lastLoginAt: true, createdAt: true, updatedAt: true }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ success: true, data: users });
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) return auth.response;
  const body = await req.json();
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const role = body?.role === "ADMIN" ? "ADMIN" : body?.role === "VIEWER" ? "VIEWER" : null;
  if (!email || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12 || !role) return NextResponse.json({ success: false, error: { code: "VALIDATION_ERROR", message: "Valid email, password (minimum 12 characters), and role are required" } }, { status: 400 });
  try {
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPasswordForStorage(password), role }, select: { id: true, email: true, role: true, active: true, createdAt: true } });
    return NextResponse.json({ success: true, data: user }, { status: 201 });
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      return NextResponse.json({ success: false, error: { code: "EMAIL_EXISTS", message: "An account with this email already exists" } }, { status: 409 });
    }
    throw err;
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) return auth.response;
  const body = await req.json();
  const id = typeof body?.id === "string" ? body.id : "";
  const role = body?.role === "ADMIN" || body?.role === "VIEWER" ? body.role : undefined;
  const active = typeof body?.active === "boolean" ? body.active : undefined;
  const password = typeof body?.password === "string" ? body.password : undefined;
  if (!id || (password !== undefined && password.length < 12) || (role === undefined && active === undefined && password === undefined)) return NextResponse.json({ success: false, error: { code: "VALIDATION_ERROR", message: "Provide a user id and at least one valid change" } }, { status: 400 });
  if (id === auth.user!.id && (active === false || role === "VIEWER")) return NextResponse.json({ success: false, error: { code: "SELF_LOCKOUT", message: "You cannot deactivate or demote your own account" } }, { status: 400 });

  const targetUser = await prisma.user.findUnique({ where: { id } });
  if (!targetUser) return NextResponse.json({ success: false, error: { code: "NOT_FOUND", message: "User not found" } }, { status: 404 });

  if (targetUser.role === "ADMIN" && targetUser.active && (active === false || role === "VIEWER")) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(987654321)`;
        const activeAdminCount = await tx.user.count({ where: { role: "ADMIN", active: true } });
        if (activeAdminCount <= 1) {
          return { error: "LAST_ADMIN_PROTECTION" as const };
        }
        const updated = await tx.user.update({
          where: { id },
          data: {
            ...(role ? { role } : {}),
            ...(active !== undefined ? { active } : {}),
            ...(password !== undefined ? { passwordHash: await hashPasswordForStorage(password) } : {}),
          },
          select: { id: true, email: true, role: true, active: true, lastLoginAt: true, createdAt: true, updatedAt: true },
        });
        await tx.userSession.deleteMany({ where: { userId: id } });
        return { user: updated };
      });

      if ("error" in result) {
        return NextResponse.json({ success: false, error: { code: "LAST_ADMIN_PROTECTION", message: "Cannot demote or deactivate the last active administrator" } }, { status: 400 });
      }
      return NextResponse.json({ success: true, data: result.user });
    } catch (err) {
      console.error("Last-admin protection transaction failed:", err);
      return NextResponse.json({ success: false, error: { code: "INTERNAL_ERROR", message: "Security check failed during admin update" } }, { status: 500 });
    }
  }

  const user = await prisma.user.update({ where: { id }, data: { ...(role ? { role } : {}), ...(active !== undefined ? { active } : {}), ...(password !== undefined ? { passwordHash: await hashPasswordForStorage(password) } : {}) }, select: { id: true, email: true, role: true, active: true, lastLoginAt: true, createdAt: true, updatedAt: true } });
  if (active === false || role !== undefined || password !== undefined) await prisma.userSession.deleteMany({ where: { userId: id } });
  return NextResponse.json({ success: true, data: user });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) return auth.response;
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ success: false, error: { code: "VALIDATION_ERROR", message: "User id is required" } }, { status: 400 });
  if (id === auth.user!.id) return NextResponse.json({ success: false, error: { code: "SELF_DELETE", message: "You cannot delete your own account" } }, { status: 400 });

  const targetUser = await prisma.user.findUnique({ where: { id } });
  if (!targetUser) return NextResponse.json({ success: false, error: { code: "NOT_FOUND", message: "User not found" } }, { status: 404 });

  if (targetUser.role === "ADMIN" && targetUser.active) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(987654321)`;
        const activeAdminCount = await tx.user.count({ where: { role: "ADMIN", active: true } });
        if (activeAdminCount <= 1) {
          return { error: "LAST_ADMIN_PROTECTION" as const };
        }
        await tx.user.delete({ where: { id } });
        return { deleted: true };
      });

      if ("error" in result) {
        return NextResponse.json({ success: false, error: { code: "LAST_ADMIN_PROTECTION", message: "Cannot delete the last active administrator" } }, { status: 400 });
      }
      return NextResponse.json({ success: true, data: { id, deleted: true } });
    } catch (err) {
      console.error("Last-admin protection transaction failed:", err);
      return NextResponse.json({ success: false, error: { code: "INTERNAL_ERROR", message: "Security check failed during admin deletion" } }, { status: 500 });
    }
  }

  await prisma.user.delete({ where: { id } });
  return NextResponse.json({ success: true, data: { id, deleted: true } });
}


