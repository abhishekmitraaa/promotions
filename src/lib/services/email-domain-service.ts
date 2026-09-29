import dns from "node:dns/promises";
import crypto from "node:crypto";
import { prisma } from "../prisma";
import {
  EmailDomain,
  EmailDomainVerificationStatus,
  EmailDnsStatus,
  EmailProviderType,
} from "@prisma/client";

// ==============================================================================
// Types & Interfaces
// ==============================================================================

export interface DnsRecordGuidance {
  type: "TXT" | "CNAME" | "MX";
  host: string;
  value: string;
  priority?: number;
  purpose: "DOMAIN_VERIFICATION" | "SPF" | "DKIM" | "DMARC" | "MX";
  description: string;
  recommended: boolean;
}

export interface DnsCheckDetail {
  status: EmailDnsStatus;
  recordFound?: string;
  expected?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface DomainVerificationResult {
  domainId: string;
  domain: string;
  overallStatus: EmailDomainVerificationStatus;
  tokenVerification: DnsCheckDetail;
  spf: DnsCheckDetail;
  dkim: DnsCheckDetail;
  dmarc: DnsCheckDetail;
  mx: DnsCheckDetail;
  lastCheckedAt: Date;
  verifiedAt?: Date | null;
}

/**
 * Resolver interface allowing dependency injection for deterministic testing
 */
export interface DnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveMx(hostname: string): Promise<Array<{ exchange: string; priority: number }>>;
}

export class DefaultDnsResolver implements DnsResolver {
  async resolveTxt(hostname: string): Promise<string[][]> {
    try {
      return await dns.resolveTxt(hostname);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOTFOUND" || error.code === "ENODATA") {
        return [];
      }
      throw err;
    }
  }

  async resolveMx(hostname: string): Promise<Array<{ exchange: string; priority: number }>> {
    try {
      return await dns.resolveMx(hostname);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOTFOUND" || error.code === "ENODATA") {
        return [];
      }
      throw err;
    }
  }
}

// ==============================================================================
// EmailDomainService
// ==============================================================================

export class EmailDomainService {
  private defaultResolver: DnsResolver;

  constructor(resolver?: DnsResolver) {
    this.defaultResolver = resolver || new DefaultDnsResolver();
  }

  /**
   * Generates provider-specific DNS configuration guidance for SPF, DKIM, DMARC, MX, and Verification
   */
  generateDnsGuidance(
    domain: string,
    providerType: EmailProviderType = EmailProviderType.GMAIL,
    verificationToken: string,
    selector = "whub"
  ): DnsRecordGuidance[] {
    const cleanDomain = domain.toLowerCase().trim();

    const records: DnsRecordGuidance[] = [
      {
        type: "TXT",
        host: cleanDomain,
        value: `whub-domain-verification=${verificationToken}`,
        purpose: "DOMAIN_VERIFICATION",
        description: "Proves ownership of this domain to WhatsApp Hub.",
        recommended: true,
      },
    ];

    // SPF Guidance
    let spfValue = "v=spf1 ~all";
    if (providerType === EmailProviderType.GMAIL) {
      spfValue = "v=spf1 include:_spf.google.com ~all";
    } else if (providerType === EmailProviderType.SES) {
      spfValue = "v=spf1 include:amazonses.com ~all";
    } else if (providerType === EmailProviderType.SMTP) {
      spfValue = "v=spf1 include:relay.mailchannels.net ~all";
    }

    records.push({
      type: "TXT",
      host: cleanDomain,
      value: spfValue,
      purpose: "SPF",
      description: "Sender Policy Framework record authorizing servers to send on behalf of this domain.",
      recommended: true,
    });

    // DKIM Guidance
    records.push({
      type: "TXT",
      host: `${selector}._domainkey.${cleanDomain}`,
      value: `v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC3pZ3dE7o3...`,
      purpose: "DKIM",
      description: "DomainKeys Identified Mail public key signature record for email authentication.",
      recommended: true,
    });

    // DMARC Guidance
    records.push({
      type: "TXT",
      host: `_dmarc.${cleanDomain}`,
      value: `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@${cleanDomain}; pct=100; adkim=r; aspf=r`,
      purpose: "DMARC",
      description: "DMARC alignment policy instructing receiving mail servers how to treat unauthenticated mail.",
      recommended: true,
    });

    // MX Guidance (if relevant)
    if (providerType === EmailProviderType.GMAIL) {
      records.push({
        type: "MX",
        host: cleanDomain,
        value: "smtp.google.com",
        priority: 1,
        purpose: "MX",
        description: "Google Workspace primary inbound mail exchange record.",
        recommended: false,
      });
    }

    return records;
  }

  /**
   * Registers a new sending domain for a client
   */
  async createDomain(
    clientId: string,
    rawDomain: string,
    providerType: EmailProviderType = EmailProviderType.GMAIL,
    selector = "whub"
  ): Promise<{ domain: EmailDomain; guidance: DnsRecordGuidance[] }> {
    const domain = rawDomain
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");

    if (!domain || !domain.includes(".") || domain.length < 4) {
      throw new Error("Invalid domain name. Must be a valid fully qualified domain (e.g. example.com).");
    }

    // Check existing
    const existing = await prisma.emailDomain.findUnique({
      where: {
        clientId_domain: {
          clientId,
          domain,
        },
      },
    });

    if (existing) {
      throw new Error(`Domain '${domain}' is already registered for this account.`);
    }

    const verificationToken = crypto.randomBytes(16).toString("hex");

    const created = await prisma.emailDomain.create({
      data: {
        clientId,
        domain,
        verificationToken,
        verificationStatus: EmailDomainVerificationStatus.PENDING,
        spfStatus: EmailDnsStatus.PENDING,
        dkimStatus: EmailDnsStatus.PENDING,
        dkimSelector: selector,
        dmarcStatus: EmailDnsStatus.PENDING,
        mxStatus: EmailDnsStatus.PENDING,
        spfExpected: providerType === EmailProviderType.GMAIL ? "v=spf1 include:_spf.google.com ~all" : "v=spf1 ~all",
      },
    });

    const guidance = this.generateDnsGuidance(domain, providerType, verificationToken, selector);

    return { domain: created, guidance };
  }

  /**
   * Performs actual DNS verification against the domain's live DNS records
   */
  async verifyDomain(
    clientId: string,
    domainId: string,
    resolverOverride?: DnsResolver
  ): Promise<DomainVerificationResult> {
    const domainRecord = await prisma.emailDomain.findFirst({
      where: { id: domainId, clientId },
    });

    if (!domainRecord) {
      throw new Error("Domain not found or access denied.");
    }

    const resolver = resolverOverride || this.defaultResolver;
    const domain = domainRecord.domain;
    const selector = domainRecord.dkimSelector || "whub";
    const expectedToken = domainRecord.verificationToken;

    // 1. Verify Domain Ownership Token
    const tokenResult = await this.verifyOwnershipToken(domain, expectedToken, resolver);

    // 2. Verify SPF Record
    const spfResult = await this.verifySpf(domain, resolver);

    // 3. Verify DKIM Record
    const dkimResult = await this.verifyDkim(domain, selector, resolver);

    // 4. Verify DMARC Record
    const dmarcResult = await this.verifyDmarc(domain, resolver);

    // 5. Verify MX Records
    const mxResult = await this.verifyMx(domain, resolver);

    // Determine overall status
    let overallStatus: EmailDomainVerificationStatus = EmailDomainVerificationStatus.PENDING;
    if (tokenResult.status === EmailDnsStatus.VERIFIED) {
      overallStatus = EmailDomainVerificationStatus.VERIFIED;
    } else {
      overallStatus = EmailDomainVerificationStatus.FAILED;
    }

    const now = new Date();
    const verifiedAt =
      overallStatus === EmailDomainVerificationStatus.VERIFIED
        ? domainRecord.verifiedAt || now
        : null;

    // Collect error messages
    const errors: string[] = [];
    if (tokenResult.status !== EmailDnsStatus.VERIFIED) errors.push(tokenResult.message);
    if (spfResult.status !== EmailDnsStatus.VERIFIED) errors.push(`SPF: ${spfResult.message}`);
    if (dkimResult.status !== EmailDnsStatus.VERIFIED) errors.push(`DKIM: ${dkimResult.message}`);
    if (dmarcResult.status !== EmailDnsStatus.VERIFIED) errors.push(`DMARC: ${dmarcResult.message}`);

    const updated = await prisma.emailDomain.update({
      where: { id: domainRecord.id },
      data: {
        verificationStatus: overallStatus,
        spfStatus: spfResult.status,
        spfRecord: spfResult.recordFound || null,
        dkimStatus: dkimResult.status,
        dkimRecord: dkimResult.recordFound || null,
        dmarcStatus: dmarcResult.status,
        dmarcRecord: dmarcResult.recordFound || null,
        dmarcPolicy: (dmarcResult.details?.policy as string) || null,
        mxStatus: mxResult.status,
        checkErrors: errors.length > 0 ? JSON.stringify(errors) : null,
        lastCheckedAt: now,
        verifiedAt,
      },
    });

    return {
      domainId: updated.id,
      domain: updated.domain,
      overallStatus,
      tokenVerification: tokenResult,
      spf: spfResult,
      dkim: dkimResult,
      dmarc: dmarcResult,
      mx: mxResult,
      lastCheckedAt: now,
      verifiedAt,
    };
  }

  // --------------------------------------------------------------------------
  // DNS Verification Helpers
  // --------------------------------------------------------------------------

  private async verifyOwnershipToken(
    domain: string,
    expectedToken: string,
    resolver: DnsResolver
  ): Promise<DnsCheckDetail> {
    const expectedValue = `whub-domain-verification=${expectedToken}`;
    try {
      // Check apex domain and challenge subdomain
      const [apexRecords, subRecords] = await Promise.all([
        resolver.resolveTxt(domain).catch(() => []),
        resolver.resolveTxt(`_whub-challenge.${domain}`).catch(() => []),
      ]);

      const allTxts = [...apexRecords, ...subRecords].map((chunk) => chunk.join(""));
      const match = allTxts.find(
        (txt) => txt.includes(expectedValue) || txt.includes(expectedToken)
      );

      if (match) {
        return {
          status: EmailDnsStatus.VERIFIED,
          recordFound: match,
          expected: expectedValue,
          message: "Domain ownership verified via DNS TXT record.",
        };
      }

      return {
        status: EmailDnsStatus.FAILED,
        expected: expectedValue,
        message: `TXT record containing '${expectedValue}' was not found in DNS for ${domain}.`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: EmailDnsStatus.FAILED,
        expected: expectedValue,
        message: `DNS resolution failed: ${msg}`,
      };
    }
  }

  private async verifySpf(domain: string, resolver: DnsResolver): Promise<DnsCheckDetail> {
    try {
      const records = await resolver.resolveTxt(domain);
      const allTxts = records.map((chunk) => chunk.join(""));
      const spfRecords = allTxts.filter((txt) => txt.toLowerCase().startsWith("v=spf1"));

      if (spfRecords.length === 0) {
        return {
          status: EmailDnsStatus.MISSING,
          message: "No SPF record (v=spf1) found on domain. Deliverability will be severely impacted.",
        };
      }

      if (spfRecords.length > 1) {
        return {
          status: EmailDnsStatus.MISCONFIGURED,
          recordFound: spfRecords.join(" | "),
          message:
            "Multiple SPF records found. RFC 7208 forbids multiple SPF records; all mail may be rejected.",
        };
      }

      const spf = spfRecords[0];

      // Syntax checks
      if (spf.includes("+all")) {
        return {
          status: EmailDnsStatus.MISCONFIGURED,
          recordFound: spf,
          message:
            "SPF record uses permissive '+all' which allows anyone in the world to spoof your domain.",
        };
      }

      if (!spf.includes("~all") && !spf.includes("-all") && !spf.includes("?all") && !spf.includes("redirect=")) {
        return {
          status: EmailDnsStatus.MISCONFIGURED,
          recordFound: spf,
          message: "SPF record lacks terminating qualifier (~all or -all).",
        };
      }

      return {
        status: EmailDnsStatus.VERIFIED,
        recordFound: spf,
        message: "Valid SPF record detected and verified.",
        details: {
          qualifier: spf.includes("-all") ? "hardfail (-all)" : "softfail (~all)",
          includes: (spf.match(/include:([^\s]+)/g) || []).map((i) => i.replace("include:", "")),
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: EmailDnsStatus.FAILED,
        message: `SPF resolution error: ${msg}`,
      };
    }
  }

  private async verifyDkim(
    domain: string,
    selector: string,
    resolver: DnsResolver
  ): Promise<DnsCheckDetail> {
    const dkimHost = `${selector}._domainkey.${domain}`;
    try {
      const records = await resolver.resolveTxt(dkimHost);
      const allTxts = records.map((chunk) => chunk.join(""));
      const dkimRecord = allTxts.find(
        (txt) => txt.includes("v=DKIM1") || txt.includes("p=") || txt.includes("k=rsa")
      );

      if (!dkimRecord) {
        return {
          status: EmailDnsStatus.MISSING,
          message: `No DKIM record found at selector host '${dkimHost}'.`,
        };
      }

      if (!dkimRecord.includes("p=") || dkimRecord.includes("p=;")) {
        return {
          status: EmailDnsStatus.MISCONFIGURED,
          recordFound: dkimRecord,
          message: "DKIM record found but public key (p=) is empty or revoked.",
        };
      }

      return {
        status: EmailDnsStatus.VERIFIED,
        recordFound: dkimRecord,
        message: `DKIM record successfully verified at ${dkimHost}.`,
        details: { selector },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: EmailDnsStatus.FAILED,
        message: `DKIM lookup error at ${dkimHost}: ${msg}`,
      };
    }
  }

  private async verifyDmarc(domain: string, resolver: DnsResolver): Promise<DnsCheckDetail> {
    const dmarcHost = `_dmarc.${domain}`;
    try {
      const records = await resolver.resolveTxt(dmarcHost);
      const allTxts = records.map((chunk) => chunk.join(""));
      const dmarcRecord = allTxts.find((txt) => txt.toLowerCase().startsWith("v=dmarc1"));

      if (!dmarcRecord) {
        return {
          status: EmailDnsStatus.MISSING,
          message: `No DMARC record found at '${dmarcHost}'. Required by Google/Yahoo since Feb 2024.`,
        };
      }

      const policyMatch = dmarcRecord.match(/p=([a-zA-Z]+)/);
      const policy = policyMatch ? policyMatch[1].toLowerCase() : "none";

      if (!["none", "quarantine", "reject"].includes(policy)) {
        return {
          status: EmailDnsStatus.MISCONFIGURED,
          recordFound: dmarcRecord,
          message: `Invalid DMARC policy '${policy}'. Must be 'none', 'quarantine', or 'reject'.`,
        };
      }

      return {
        status: EmailDnsStatus.VERIFIED,
        recordFound: dmarcRecord,
        message: `DMARC record verified with policy '${policy}'.`,
        details: {
          policy,
          isStrict: policy === "reject" || policy === "quarantine",
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: EmailDnsStatus.FAILED,
        message: `DMARC lookup error at ${dmarcHost}: ${msg}`,
      };
    }
  }

  private async verifyMx(domain: string, resolver: DnsResolver): Promise<DnsCheckDetail> {
    try {
      const mxRecords = await resolver.resolveMx(domain);
      if (!mxRecords || mxRecords.length === 0) {
        return {
          status: EmailDnsStatus.MISSING,
          message: "No MX records found for domain. Inbound replies cannot be delivered.",
        };
      }

      return {
        status: EmailDnsStatus.VERIFIED,
        recordFound: mxRecords.map((r) => `${r.priority} ${r.exchange}`).join(", "),
        message: `${mxRecords.length} active MX server(s) verified.`,
        details: { count: mxRecords.length },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: EmailDnsStatus.FAILED,
        message: `MX resolution failed: ${msg}`,
      };
    }
  }

  /**
   * Retrieves all domains for a client with live computed health
   */
  async listDomains(clientId: string): Promise<EmailDomain[]> {
    return prisma.emailDomain.findMany({
      where: { clientId },
      include: {
        senderIdentities: {
          select: { id: true, email: true, verified: true, reputationScore: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Deletes a domain and unlinks related senders
   */
  async deleteDomain(clientId: string, domainId: string): Promise<void> {
    const existing = await prisma.emailDomain.findFirst({
      where: { id: domainId, clientId },
    });
    if (!existing) {
      throw new Error("Domain not found or access denied.");
    }

    await prisma.emailDomain.delete({
      where: { id: domainId },
    });
  }
}

export const emailDomainService = new EmailDomainService();
