# Email Deliverability, Domains & Reputation Architecture

This document describes the production-grade email deliverability subsystem for WhatsApp Hub. The deliverability layer is designed **provider-agnostically**, enforcing strict DNS security, live verification checks, Google & Yahoo 2024+ sender compliance, automated bounce/complaint suppression, real-time failure diagnostics, and sender reputation monitoring.

---

## 1. Architectural Overview

```
                               ┌────────────────────────────────────────────────────────┐
                               │       Deliverability Dashboard Console                 │
                               │        (/dashboard/email/deliverability)               │
                               └───────────┬────────────────────────────┬───────────────┘
                                           │                            │
                                           ▼                            ▼
                      ┌────────────────────────────┐       ┌────────────────────────────┐
                      │   Domain & DNS Service     │       │    Reputation & Quotas     │
                      │   (Node dns.promises)      │       │ (7d/24h Rolling Analytics) │
                      └─────────────┬──────────────┘       └─────────────┬──────────────┘
                                    │                                    │
                                    ▼                                    ▼
                      ┌────────────────────────────┐       ┌────────────────────────────┐
                      │  Live Authoritative DNS    │       │     PostgreSQL Schema      │
                      │  (TXT, SPF, DKIM, DMARC)   │       │(EmailDomain, EmailDelivery)│
                      └────────────────────────────┘       └─────────────▲──────────────┘
                                                                         │
                                    ┌────────────────────────────────────┘
                                    │
                      ┌─────────────┴──────────────┐       ┌────────────────────────────┐
                      │    Delivery Diagnostics    │◄──────┤     Inbound Webhooks &     │
                      │  (SMTP Code Classification)│       │    Queue Worker Failures   │
                      └────────────────────────────┘       └────────────────────────────┘
```

---

## 2. Core Pillars & Capabilities

### 2.1 Provider-Agnostic Domain Verification
- **Uncompromised Verification Rule**: DNS checks are **never presented as successful unless actually verified** via live DNS queries.
- **Verification Token**: Each domain generates a cryptographically secure 32+ character verification token:
  - Record: `TXT`
  - Host: `yourdomain.com` or `_whub-challenge.yourdomain.com`
  - Expected Value: `whub-domain-verification=<token>`
- **Status State Machine**:
  - `PENDING`: Initial state upon registration.
  - `VERIFIED`: Token confirmed present in DNS and authorized.
  - `FAILED`: Token missing, query timed out, or unresolvable.
  - `REVOKED`: Domain explicitly deleted or disabled.

### 2.2 SPF Guidance & Validation
- **RFC 7208 Compliance**:
  - Rejects domains with **multiple SPF records** (`MISCONFIGURED`).
  - Flags permissive `+all` policies as dangerous (`MISCONFIGURED`).
  - Validates presence of provider-specific include directives:
    - **Google Workspace / Gmail**: `v=spf1 include:_spf.google.com ~all`
    - **Amazon SES**: `v=spf1 include:amazonses.com ~all`
    - **Generic SMTP Relay**: `v=spf1 include:<relay-host> ~all`

### 2.3 DKIM Configuration & Status
- **Host**: `<selector>._domainkey.<domain>` (default selector: `whub`).
- **Record**: `v=DKIM1; k=rsa; p=<public-key>`.
- **Validation**:
  - Resolves selector TXT record.
  - Validates public key `p=` is non-empty and well-formed.

### 2.4 DMARC Guidance & Alignment
- **Host**: `_dmarc.<domain>`.
- **Recommended Value**: `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@<domain>; pct=100; adkim=r; aspf=r`.
- **Policy Evaluation**:
  - `p=none`: Permitted for ramp-up, but flagged with a recommendation to upgrade.
  - `p=quarantine`: Verified and compliant.
  - `p=reject`: Maximum protection against domain spoofing.

### 2.5 Bounce & Complaint Monitoring & Auto-Suppression
- **Hard Bounce Handling**:
  - Ingestion of permanent 5.x.x failure events (e.g. `550 5.1.1 User unknown`).
  - **Immediate Action**: Auto-creates `EmailSuppression` record (`reason: HARD_BOUNCE`) and sets `EmailContact.status = BOUNCED`.
- **Soft Bounce Handling**:
  - Ingestion of transient 4.x.x events (e.g. `452 4.2.2 Mailbox full`, rate limits).
  - Triggers BullMQ worker retry with exponential backoff.
  - **Does NOT** permanently suppress on first occurrence.
- **Complaint Handling (Spam Reports / FBL)**:
  - Ingestion of user spam reports or ISP feedback loops.
  - **Immediate Action**: Auto-creates `EmailSuppression` record (`reason: COMPLAINT`) and sets `EmailContact.status = COMPLAINED`.

### 2.6 Pre-Flight Suppression Management
- Before an email is dispatched in `EmailService.send()`, `CampaignWorker`, or `PromotionalDeliveryWorker`:
  - Recipient address is checked against `EmailSuppression`.
  - If suppressed, sending is aborted, marking the delivery as `FAILED` (`errorCode: "RECIPIENT_SUPPRESSED"`, `failureCategory: "INVALID_RECIPIENT"`), saving provider quota and protecting sender reputation.

### 2.7 Sender Reputation Indicators & Google/Yahoo Compliance
- **Mathematical Health Score (0–100)**:
  1. **Domain Authentication (Weight: 30%)**: SPF verified (+10), DKIM verified (+10), DMARC quarantine/reject (+10).
  2. **Complaint Rate (Weight: 35%)**: 
     - &le; 0.05%: 35 pts (Maximum)
     - 0.05% - 0.10%: 25 pts (Good)
     - 0.10% - 0.30%: 10 pts (Warning)
     - &gt; 0.30%: 0 pts (Google/Yahoo violation threshold)
  3. **Hard Bounce Rate (Weight: 25%)**:
     - &le; 1.0%: 25 pts (Clean)
     - 1.0% - 2.0%: 18 pts (Acceptable)
     - 2.0% - 5.0%: 8 pts (Degraded)
     - &gt; 5.0%: 0 pts (High risk)
  4. **Delivery Success Rate (Weight: 10%)**:
     - &ge; 98%: 10 pts
     - &ge; 95%: 7 pts
     - &ge; 90%: 4 pts
     - &lt; 90%: 0 pts
- **Reputation Grades**: `EXCELLENT` (&ge;90), `GOOD` (75-89), `FAIR` (50-74), `POOR` (25-49), `CRITICAL` (&lt;25).
- **Google & Yahoo Compliance Checklist**:
  - [x] SPF record verified
  - [x] DKIM public key verified
  - [x] DMARC record verified
  - [x] Complaint rate strictly &lt; 0.30%
  - [x] Native `List-Unsubscribe` one-click header supported

### 2.8 Provider Quota Monitoring
- Tracks daily and hourly outbound volume against provider constraints:
  - **Google Workspace**: 2,000 emails / day
  - **Gmail Consumer**: 500 emails / day
  - **Amazon SES**: 50,000 emails / day (configurable)
  - **Custom SMTP**: 10,000 emails / day (configurable)
- Quota Status Badges:
  - `NORMAL`: &lt; 80% consumed
  - `WARNING`: 80% &ndash; 94% consumed
  - `CRITICAL`: 95% &ndash; 99% consumed
  - `EXHAUSTED`: 100% consumed (triggers pre-flight block until 00:00 UTC)

### 2.9 Delivery Failure Diagnostics Engine
Every failure is categorized into standardized diagnostic categories with actionable operator advice:

| Category | Typical SMTP Codes | Hard/Soft | Remediation Advice |
|---|---|---|---|
| `AUTHENTICATION_FAILED` | `550 5.7.26`, `550 5.7.1` | Hard | Check SPF/DKIM/DMARC in Deliverability tab. Add authorized sending IP/include. |
| `SPAM_BLOCK` | `554 5.7.1`, Spamhaus | Hard | Review content for spam triggers. Check IP/domain on DNSBLs. Warm up domain. |
| `INVALID_RECIPIENT` | `550 5.1.1` | Hard | Address auto-suppressed. Clean recipient lists. Enforce double opt-in. |
| `MAILBOX_FULL` | `452 4.2.2` | Soft | Auto-retry with backoff. Suppress after 3 persistent failures. |
| `DNS_LOOKUP_FAILURE` | `550 5.1.2`, NXDOMAIN | Hard | Verify recipient domain spelling and active MX records. |
| `RATE_LIMITED` | `421 4.7.0` | Soft | Recipient server throttling. Worker applies exponential backoff. |
| `TLS_ERROR` | `550 5.7.0` | Soft | Ensure TLS 1.2+ is supported by your outbound provider/relays. |
| `QUOTA_EXCEEDED` | `450 4.4.5` | Soft | Daily sending quota reached. Pause campaigns until 00:00 UTC reset. |

---

## 3. REST API Endpoints

- `GET /api/admin/email/domains` &mdash; List configured domains with DNS statuses.
- `POST /api/admin/email/domains` &mdash; Register domain and generate verification token.
- `GET /api/admin/email/domains/[id]` &mdash; Retrieve domain details and copyable DNS records.
- `POST /api/admin/email/domains/[id]/verify` &mdash; Execute live DNS verification.
- `DELETE /api/admin/email/domains/[id]` &mdash; Delete domain.
- `GET /api/admin/email/deliverability/overview` &mdash; Aggregated reputation report, 24h/7d metrics, and compliance audit.
- `GET /api/admin/email/deliverability/diagnostics` &mdash; Failure stream with categorized diagnostic badges and remediation advice.
- `GET /api/admin/email/deliverability/quotas` &mdash; Provider daily quota consumption, hourly rates, and reset countdowns.

---

## 4. Verification & Testing

Run the automated deliverability certification suite:
```bash
npm run test:email:deliverability
```
All 10 flows and 55 assertions are verified:
- Domain creation and token generation
- Provider-agnostic DNS guidance
- Strict DNS verification (missing and misconfigured cases)
- Authoritative DNS verification (verified passing cases)
- Sender identity domain association
- Hard vs soft bounce handling and complaint auto-suppression
- Pre-flight suppression blocking and tenant isolation
- Diagnostic classification across all 8 failure categories
- Mathematical reputation scoring and Google/Yahoo compliance
- Provider daily quotas and reset scheduling
