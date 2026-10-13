/**
 * Formats the From address for an outgoing email, adding the display name of the tenant's
 * verified sender identity for that address (e.g. "Cosora" <cosora.work@gmail.com>).
 * Without it, mail clients fall back to the bare address or its local part.
 */

import { prisma } from "../../prisma";

export async function formatSenderAddress(clientId: string, address: string): Promise<string> {
  // Already carries a display name
  if (!address || address.includes("<")) return address;

  const identity = await prisma.emailSenderIdentity.findUnique({
    where: { clientId_email: { clientId, email: address.trim().toLowerCase() } },
    select: { name: true, verified: true },
  });
  const name = identity?.verified ? identity.name?.trim() : undefined;
  if (!name) return address;

  return `"${name.replace(/["\r\n]/g, "")}" <${address.trim()}>`;
}
