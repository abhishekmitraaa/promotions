import dns from "dns";
import net from "net";

/**
 * Result of SSRF safety validation.
 */
export interface SsrfCheckResult {
  safe: boolean;
  reason?: string;
  resolvedIps?: string[];
}

/**
 * Converts an IPv4 dotted string into a 32-bit unsigned integer.
 * Also parses single numeric integer representations (e.g., 2130706433) or hex.
 */
export function ipToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length === 4) {
    let num = 0;
    for (let i = 0; i < 4; i++) {
      const part = parts[i];
      let val: number;
      if (part.startsWith("0x") || part.startsWith("0X")) {
        val = parseInt(part, 16);
      } else if (part.startsWith("0") && part.length > 1 && /^[0-7]+$/.test(part)) {
        val = parseInt(part, 8);
      } else {
        val = parseInt(part, 10);
      }
      if (isNaN(val) || val < 0 || val > 255) return null;
      num = (num << 8) + val;
    }
    return num >>> 0;
  }

  // Handle pure integer representation (e.g., 2130706433) or hex (0x7f000001)
  if (/^0x[0-9a-fA-F]+$/i.test(ip)) {
    const parsed = parseInt(ip, 16);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 0xffffffff) {
      return parsed >>> 0;
    }
  }
  if (/^\d+$/.test(ip)) {
    const parsed = parseInt(ip, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 0xffffffff) {
      return parsed >>> 0;
    }
  }

  return null;
}

/**
 * Checks whether an IPv4 address is in a private, loopback, link-local,
 * CGNAT, multicast, or reserved range according to IANA specifications.
 */
export function isPrivateOrReservedIPv4(ipNum: number): boolean {
  // 0.0.0.0/8 (Current network)
  if (((ipNum & 0xff000000) >>> 0) === 0x00000000) return true;

  // 10.0.0.0/8 (Private-Use RFC 1918)
  if (((ipNum & 0xff000000) >>> 0) === 0x0a000000) return true;

  // 100.64.0.0/10 (Shared Address Space / CGNAT RFC 6598)
  if (((ipNum & 0xffc00000) >>> 0) === 0x64400000) return true;

  // 127.0.0.0/8 (Loopback RFC 1122)
  if (((ipNum & 0xff000000) >>> 0) === 0x7f000000) return true;

  // 169.254.0.0/16 (Link-Local RFC 3927, includes cloud metadata 169.254.169.254)
  if (((ipNum & 0xffff0000) >>> 0) === 0xa9fe0000) return true;

  // 172.16.0.0/12 (Private-Use RFC 1918: 172.16.0.0 to 172.31.255.255)
  if (((ipNum & 0xfff00000) >>> 0) === 0xac100000) return true;

  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (((ipNum & 0xffffff00) >>> 0) === 0xc0000000) return true;

  // 192.0.2.0/24 (TEST-NET-1)
  if (((ipNum & 0xffffff00) >>> 0) === 0xc0000200) return true;

  // 192.168.0.0/16 (Private-Use RFC 1918)
  if (((ipNum & 0xffff0000) >>> 0) === 0xc0a80000) return true;

  // 198.18.0.0/15 (Benchmarking RFC 2544)
  if (((ipNum & 0xfffe0000) >>> 0) === 0xc6120000) return true;

  // 198.51.100.0/24 (TEST-NET-2)
  if (((ipNum & 0xffffff00) >>> 0) === 0xc6336400) return true;

  // 203.0.113.0/24 (TEST-NET-3)
  if (((ipNum & 0xffffff00) >>> 0) === 0xcb007100) return true;

  // 224.0.0.0/4 (Multicast RFC 5771)
  if (((ipNum & 0xf0000000) >>> 0) === 0xe0000000) return true;

  // 240.0.0.0/4 (Reserved / Future Use RFC 1112) and 255.255.255.255 (Broadcast)
  if (((ipNum & 0xf0000000) >>> 0) === 0xf0000000) return true;

  return false;
}

/**
 * Checks whether an IPv6 address is in a loopback, link-local, unique local,
 * multicast, or IPv4-mapped address range.
 */
export function isPrivateOrReservedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // Loopback ::1
  if (normalized === "::1" || normalized === "0000:0000:0000:0000:0000:0000:0000:0001") return true;

  // Unspecified ::
  if (normalized === "::" || /^0+:0+:0+:0+:0+:0+:0+:0+$/.test(normalized)) return true;

  // IPv4-mapped IPv6: ::ffff:x.x.x.x
  if (normalized.startsWith("::ffff:") || normalized.includes(":ffff:")) {
    const ipv4Part = normalized.split(":").pop();
    if (ipv4Part) {
      const num = ipToNumber(ipv4Part);
      if (num !== null && isPrivateOrReservedIPv4(num)) return true;
    }
    return true; // Treat IPv4-mapped as restricted
  }

  // Unique Local Address (ULA) fc00::/7 (fc00... to fdff...)
  if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return true;

  // Link-Local Unicast fe80::/10 (fe80... to febf...)
  if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return true;

  // Multicast ff00::/8
  if (/^ff[0-9a-f]{2}:/i.test(normalized)) return true;

  return false;
}

/**
 * Determines if a single IP string (IPv4 or IPv6) is private, loopback, or reserved.
 */
export function isPrivateIp(ip: string): boolean {
  const trimmed = ip.trim().replace(/^\[|\]$/g, ""); // strip brackets if [::1]

  const ipv4Num = ipToNumber(trimmed);
  if (ipv4Num !== null) {
    return isPrivateOrReservedIPv4(ipv4Num);
  }

  if (net.isIPv6(trimmed) || trimmed.includes(":")) {
    return isPrivateOrReservedIPv6(trimmed);
  }

  return false;
}

/**
 * Validates a webhook URL statically (scheme, format, hostname).
 */
export function validateWebhookUrlSync(urlString: string): { valid: boolean; reason?: string } {
  try {
    const parsed = new URL(urlString);

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { valid: false, reason: "Unsupported protocol. Only http: and https: are allowed." };
    }

    const rawHostname = parsed.hostname.toLowerCase().trim().replace(/^\[|\]$/g, "");

    // Check common local domain patterns
    if (
      rawHostname === "localhost" ||
      rawHostname.endsWith(".localhost") ||
      rawHostname.endsWith(".local") ||
      rawHostname.endsWith(".internal") ||
      rawHostname.endsWith(".localdomain")
    ) {
      return { valid: false, reason: `Disallowed hostname: ${rawHostname}` };
    }

    // Direct IP checks (IPv4 or IPv6)
    if (isPrivateIp(rawHostname)) {
      return { valid: false, reason: `Private, loopback, or reserved IP address is forbidden: ${rawHostname}` };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: "Invalid URL string" };
  }
}

/**
 * Validates a webhook URL at delivery time, resolving DNS to verify that
 * the target network address does not resolve to private/internal networks (mitigating DNS rebinding).
 */
export async function validateWebhookUrlForDelivery(urlString: string): Promise<SsrfCheckResult> {
  const syncCheck = validateWebhookUrlSync(urlString);
  if (!syncCheck.valid) {
    return { safe: false, reason: syncCheck.reason };
  }

  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname.toLowerCase().trim().replace(/^\[|\]$/g, "");

    // If hostname is already an IP, it passed validateWebhookUrlSync
    if (net.isIP(hostname)) {
      return { safe: true, resolvedIps: [hostname] };
    }

    // Resolve DNS records
    const lookupResults = await dns.promises.lookup(hostname, { all: true });

    if (!lookupResults || lookupResults.length === 0) {
      return { safe: false, reason: `DNS lookup failed to resolve hostname: ${hostname}` };
    }

    const resolvedIps = lookupResults.map((r) => r.address);

    for (const res of lookupResults) {
      if (isPrivateIp(res.address)) {
        return {
          safe: false,
          reason: `DNS for ${hostname} resolved to forbidden internal/private IP: ${res.address}`,
          resolvedIps,
        };
      }
    }

    return { safe: true, resolvedIps };
  } catch (err) {
    const message = err instanceof Error ? err.message : "DNS resolution error";
    return { safe: false, reason: `Failed to resolve webhook host: ${message}` };
  }
}
