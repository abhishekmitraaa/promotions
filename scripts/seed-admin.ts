import { prisma } from "../src/lib/prisma";
import { hashPasswordForStorage } from "../src/lib/auth";

const email = process.env.DEMO_ADMIN_EMAIL || "cosora.demo@gmail.com";
const password = process.env.DEMO_ADMIN_PASSWORD;
if (!password) throw new Error("Set DEMO_ADMIN_PASSWORD before running this script.");

async function main() {
  if (password.length < 12) throw new Error("DEMO_ADMIN_PASSWORD must be at least 12 characters.");
  const passwordHash = await hashPasswordForStorage(password);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, role: "ADMIN", active: true },
    create: { email, passwordHash, role: "ADMIN", active: true },
  });
  console.log(`Admin account ready: ${user.email} (role=${user.role})`);
}
main().finally(() => prisma.$disconnect());
