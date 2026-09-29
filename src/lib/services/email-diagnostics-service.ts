import { EmailFailureCategory } from "@prisma/client";

export interface DiagnosticResult {
  category: EmailFailureCategory;
  smtpCode: string | null;
  isHardBounce: boolean;
  isRetryable: boolean;
  humanSummary: string;
  recommendedRemediation: string;
  technicalDetails?: Record<string, unknown>;
}

export class EmailDiagnosticsService {
  /**
   * Diagnoses an error message, SMTP response, or failure code and produces structured guidance
   */
  classifyFailure(
    rawMessage: string | null | undefined,
    rawCode?: string | null
  ): DiagnosticResult {
    const text = `${rawCode || ""} ${rawMessage || ""}`.toLowerCase();

    // 1. Spam / Blocklist / Content Filter Blocks (higher precedence than generic 5.7.1)
    if (
      text.includes("spam") ||
      text.includes("blocklist") ||
      text.includes("blacklist") ||
      text.includes("reputation") ||
      text.includes("barracuda") ||
      text.includes("spamhaus") ||
      text.includes("uribl") ||
      text.includes("554 5.7.1") ||
      text.includes("poor reputation") ||
      text.includes("bulk mail")
    ) {
      return {
        category: EmailFailureCategory.SPAM_BLOCK,
        smtpCode: "554 5.7.1",
        isHardBounce: true,
        isRetryable: false,
        humanSummary: "Message was blocked by the recipient's spam filter or IP/domain reputation blocklist.",
        recommendedRemediation: "Review message content for spam triggers. Check your domain and IP on major DNSBLs (Spamhaus, Barracuda). Throttle sending speed and warm up your domain.",
        technicalDetails: { rawCode, rawMessage },
      };
    }

    // 2. Authentication / SPF / DKIM / DMARC Rejections
    if (
      text.includes("5.7.26") ||
      text.includes("5.7.1") ||
      text.includes("spf check failed") ||
      text.includes("dkim check failed") ||
      text.includes("dmarc policy") ||
      text.includes("unauthenticated") ||
      text.includes("does not pass authentication checks") ||
      text.includes("sender not permitted")
    ) {
      const isAuthCode = text.includes("5.7.26") || text.includes("5.7.1");
      return {
        category: EmailFailureCategory.AUTHENTICATION_FAILED,
        smtpCode: isAuthCode ? (text.includes("5.7.26") ? "550 5.7.26" : "550 5.7.1") : "550 5.7.0",
        isHardBounce: true,
        isRetryable: false,
        humanSummary: "Recipient mail server rejected message due to missing or failing SPF, DKIM, or DMARC authentication.",
        recommendedRemediation: "Verify your domain's SPF, DKIM, and DMARC records in the Deliverability tab. Ensure your sending server/provider is authorized in your SPF include directive.",
        technicalDetails: { rawCode, rawMessage },
      };
    }

    // 3. Invalid Recipient / Non-Existent Address / Mailbox Not Found
    if (
      text.includes("550 5.1.1") ||
      text.includes("5.1.1") ||
      text.includes("user unknown") ||
      text.includes("recipient unknown") ||
      text.includes("mailbox not found") ||
      text.includes("no such user") ||
      text.includes("does not exist") ||
      text.includes("invalid recipient")
    ) {
      return {
        category: EmailFailureCategory.INVALID_RECIPIENT,
        smtpCode: "550 5.1.1",
        isHardBounce: true,
        isRetryable: false,
        humanSummary: "Recipient email address does not exist on the target mail server.",
        recommendedRemediation: "Address has been automatically added to the Suppression List. Clean your email contact lists and implement double opt-in.",
        technicalDetails: { rawCode, rawMessage },
      };
    }

    // 4. Mailbox Full / Quota Exceeded (Soft Bounce)
    if (
      text.includes("452 4.2.2") ||
      text.includes("4.2.2") ||
      text.includes("mailbox is full") ||
      text.includes("quota exceeded") ||
      text.includes("storage limit") ||
      text.includes("user over quota")
    ) {
      return {
        category: EmailFailureCategory.MAILBOX_FULL,
        smtpCode: "452 4.2.2",
        isHardBounce: false,
        isRetryable: true,
        humanSummary: "Recipient mailbox is full and cannot accept incoming messages temporarily.",
        recommendedRemediation: "Soft bounce: Queue worker will automatically retry with exponential backoff. If persistent across 3 attempts, address will be suppressed.",
        technicalDetails: { rawCode, rawMessage },
      };
    }

    // 5. DNS Lookup Failure / MX Missing
    if (
      text.includes("nxdomain") ||
      text.includes("mx record not found") ||
      text.includes("no mx") ||
      text.includes("domain not found") ||
      text.includes("dns query failed") ||
      text.includes("host not found") ||
      text.includes("enotfound")
    ) {
      return {
        category: EmailFailureCategory.DNS_LOOKUP_FAILURE,
        smtpCode: "550 5.1.2",
        isHardBounce: true,
        isRetryable: false,
        humanSummary: "Recipient domain has no valid MX records or the domain name does not exist in DNS.",
        recommendedRemediation: "Check recipient email for typos (e.g. @gmai.com vs @gmail.com). Suppress this address if the domain is permanently defunct.",
        technicalDetails: { rawCode, rawMessage },
      };
    }

    // 6. Rate Limited / Server Throttled (Soft Bounce)
    if (
      text.includes("421") ||
      text.includes("4.7.0") ||
      text.includes("too many connections") ||
      text.includes("rate limit") ||
      text.includes("throttled") ||
      text.includes("try again later") ||
      text.includes("temporarily deferred")
    ) {
      return {
        category: EmailFailureCategory.RATE_LIMITED,
        smtpCode: "421 4.7.0",
        isHardBounce: false,
        isRetryable: true,
        humanSummary: "Recipient mail server is throttling incoming messages due to temporary connection volume.",
        recommendedRemediation: "Soft bounce: Worker will back off exponentially. Decrease campaign concurrency or configure sending rate limits.",
        technicalDetails: { rawCode, rawMessage },
      };
    }

    // 7. TLS / Security Negotiation Failure
    if (
      text.includes("tls") ||
      text.includes("ssl") ||
      text.includes("certificate") ||
      text.includes("handshake") ||
      text.includes("cipher")
    ) {
      return {
        category: EmailFailureCategory.TLS_ERROR,
        smtpCode: "550 5.7.0",
        isHardBounce: false,
        isRetryable: true,
        humanSummary: "TLS encryption negotiation failed between mail servers.",
        recommendedRemediation: "Ensure modern TLS (v1.2 or v1.3) is supported by your outbound provider/relays.",
        technicalDetails: { rawCode, rawMessage },
      };
    }

    // 8. Provider Quota Exceeded
    if (
      text.includes("quota_exceeded") ||
      text.includes("daily sending quota") ||
      text.includes("user-rate limit") ||
      text.includes("sending limit reached")
    ) {
      return {
        category: EmailFailureCategory.QUOTA_EXCEEDED,
        smtpCode: "450 4.4.5",
        isHardBounce: false,
        isRetryable: true,
        humanSummary: "Your outbound provider's daily or hourly sending quota has been reached.",
        recommendedRemediation: "Pause campaigns until the daily quota resets at midnight UTC, or upgrade your provider tier (e.g., from consumer Gmail to Google Workspace, or request an Amazon SES quota increase).",
        technicalDetails: { rawCode, rawMessage },
      };
    }

    // Default: Unknown / Uncategorized
    return {
      category: EmailFailureCategory.UNKNOWN,
      smtpCode: rawCode || null,
      isHardBounce: false,
      isRetryable: true,
      humanSummary: rawMessage || "An unspecified delivery error occurred.",
      recommendedRemediation: "Inspect raw provider event logs and retry if transient.",
      technicalDetails: { rawCode, rawMessage },
    };
  }
}

export const emailDiagnosticsService = new EmailDiagnosticsService();
