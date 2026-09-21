import crypto from "crypto";
import { prisma } from "./prisma";

export type UserRole = "ADMIN" | "VIEWER";
const SESSION_COOKIE = "whatsapp_hub_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function base64url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

function hashPassword(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export async function hashPasswordForStorage(password: string) {
  const salt = crypto.randomBytes(16);
  const derived = await hashPassword(password, salt);
  return `scrypt$16384$8$1$${base64url(salt)}$${base64url(derived)}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [algorithm, n, r, p, saltText, hashText] = stored.split("$");
  if (algorithm !== "scrypt" || n !== "16384" || r !== "8" || p !== "1" || !saltText || !hashText) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    const actual = await hashPassword(password, salt);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function hashSessionToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createSessionToken(user: { id: string; email: string; role: UserRole }) {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_SESSION_SECRET must be configured with at least 32 characters");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = JSON.stringify({ id: user.id, email: user.email, role: user.role, expiresAt });
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return { token: `${base64url(payload)}.${signature}`, expiresAt };
}

export function verifySessionTokenNode(token: string) {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  try {
    const payload = Buffer.from(encoded, "base64url").toString("utf8");
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const parsed = JSON.parse(payload) as { id?: string; email?: string; role?: string; expiresAt?: number };
    if (!parsed.id || !parsed.email || (parsed.role !== "ADMIN" && parsed.role !== "VIEWER") || !Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= Date.now()) return null;
    return { id: parsed.id, email: parsed.email, role: parsed.role as UserRole, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export async function getAuthenticatedUser(req: Request) {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)whatsapp_hub_session=([^;]+)/);
  const token = match ? decodeURIComponent(match[1]) : null;
  if (!token) return null;
  const session = verifySessionTokenNode(token);
  if (!session) return null;
  const dbSession = await prisma.userSession.findUnique({ where: { tokenHash: hashSessionToken(token) }, include: { user: true } });
  if (!dbSession || dbSession.expiresAt <= new Date() || !dbSession.user.active || dbSession.user.id !== session.id) return null;
  return dbSession.user;
}

export async function requireUser(req: Request, role?: UserRole) {
  const user = await getAuthenticatedUser(req);
  if (!user) return { user: null, response: new Response(JSON.stringify({ success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } }), { status: 401, headers: { "Content-Type": "application/json" } }) };
  if (role && user.role !== role) return { user: null, response: new Response(JSON.stringify({ success: false, error: { code: "FORBIDDEN", message: "Admin role required" } }), { status: 403, headers: { "Content-Type": "application/json" } }) };
  return { user, response: null };
}

export { SESSION_COOKIE, SESSION_TTL_MS };
