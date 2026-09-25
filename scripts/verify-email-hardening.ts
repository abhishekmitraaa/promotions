/**
 * Comprehensive Email Platform E2E Hardening & Correctness Verification Suite
 *
 * Verifies all 9 required capabilities:
 * 1. Public Transactional API -> DB -> Queue (honest queueing, stable job ID)
 * 2. Public Promotional API -> DB -> Correct Queue -> Worker (SEND_PROMOTIONAL, RFC 8058 headers, suppression & consent re-checks)
 * 3. Duplicate Idempotency Key Deduplication
 * 4. Redis Enqueue Failure Honesty (DB failure state + HTTP 500, no fake 202)
 * 5. Campaign Resource Cross-Tenant Rejection (all 5 resources: template, version, list, segment, sender identity)
 * 6. Deterministic Rate Limiting
 * 7. API Authentication (401 on missing/invalid key)
 * 8. Tenant Isolation (strict cross-tenant barriers)
 * 9. ADMIN vs VIEWER RBAC Rules (403 on VIEWER mutations)
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.AUTH_SESSION_SECRET ||= "hardening-test-session-secret-32-characters-minimum";
process.env.API_KEY_PEPPER ||= "hardening-test-api-key-pepper-32-characters-min";

import crypto from "crypto";
import { NextRequest } from "next/server";
import { prisma } from "../src/lib/prisma";
import { generateApiKey } from "../src/lib/crypto";
import { createSessionToken, hashSessionToken } from "../src/lib/auth";
import { checkRateLimit } from "../src/lib/rate-limit";
import { POST as sendEmailRoute } from "../src/app/api/v1/email/send/route";
import { POST as createCampaignRoute, GET as listCampaignsRoute } from "../src/app/api/email/campaigns/route";
import { PATCH as updateCampaignRoute } from "../src/app/api/email/campaigns/[id]/route";
import { POST as sendCampaignRoute } from "../src/app/api/email/campaigns/[id]/send/route";
import { EmailCampaignService } from "../src/lib/services/email-campaign-service";
import { processPromotionalDeliveryJob } from "../src/lib/email/queue/promotional-delivery-worker";
import { getTransactionalQueue, getCampaignQueue } from "../src/lib/email/queue/queues";
import {
  JOB_NAMES,
  getTransactionalJobId,
  getPromotionalJobId,
  PromotionalJobData,
} from "../src/lib/email/queue/types";
import { EmailProvider, EmailSendRequest, EmailSendResult } from "../src/lib/email/types";
import {
  EmailCampaignStatus,
  EmailDeliveryStatus,
  EmailProviderType,
  EmailType,
  EmailSuppressionReason,
} from "@prisma/client";
import { Job, UnrecoverableError } from "bullmq";

let passed = 0;
let failed = 0;

function testAssert(condition: boolean, description: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${description}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${description}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

class MockHardeningProvider implements EmailProvider {
  id = "mock-hardening-provider";
  name = "Mock Hardening Provider";
  providerType = EmailProviderType.MOCK;
  sentRequests: EmailSendRequest[] = [];

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    this.sentRequests.push(request);
    return {
      accepted: true,
      success: true,
      providerName: this.name,
      providerType: this.providerType,
      providerMessageId: `msg-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      providerStatus: EmailDeliveryStatus.SENT,
      sentAt: new Date(),
    };
  }
}

// In-Memory Test State Store (Protects Remote Database)
interface InMemoryStore {
  clients: any[];
  apiKeys: any[];
  users: any[];
  userSessions: any[];
  contacts: any[];
  suppressions: any[];
  templates: any[];
  templateVersions: any[];
  lists: any[];
  segments: any[];
  senderIdentities: any[];
  campaigns: any[];
  deliveries: any[];
  campaignRecipients: any[];
}

const store: InMemoryStore = {
  clients: [],
  apiKeys: [],
  users: [],
  userSessions: [],
  contacts: [],
  suppressions: [],
  templates: [],
  templateVersions: [],
  lists: [],
  segments: [],
  senderIdentities: [],
  campaigns: [],
  deliveries: [],
  campaignRecipients: [],
};

const enqueuedJobs: {
  transactional: Map<string, any>;
  campaign: Map<string, any>;
} = {
  transactional: new Map(),
  campaign: new Map(),
};

function setupHardeningMocks() {
  // Mock Queues
  const txnQueue = getTransactionalQueue();
  const campQueue = getCampaignQueue();

  (txnQueue as any).add = async (name: string, data: any, opts: any) => {
    const job = { id: opts?.jobId || `job-${Date.now()}`, name, data, opts };
    enqueuedJobs.transactional.set(job.id, job);
    return job;
  };
  (txnQueue as any).getJob = async (jobId: string) => {
    return enqueuedJobs.transactional.get(jobId) || null;
  };

  (campQueue as any).add = async (name: string, data: any, opts: any) => {
    const job = { id: opts?.jobId || `job-${Date.now()}`, name, data, opts };
    enqueuedJobs.campaign.set(job.id, job);
    return job;
  };
  (campQueue as any).getJob = async (jobId: string) => {
    return enqueuedJobs.campaign.get(jobId) || null;
  };

  // Mock Prisma delegates
  (prisma.apiClient as any).findUnique = async ({ where }: any) => {
    return store.clients.find((c) => c.id === where.id) || null;
  };
  (prisma.apiClient as any).create = async ({ data }: any) => {
    const record = { id: data.id || `cli-${Date.now()}-${Math.random().toString(36).substring(7)}`, active: true, ...data };
    store.clients.push(record);
    return record;
  };

  (prisma.apiKey as any).findUnique = async ({ where }: any) => {
    const key = store.apiKeys.find((k) => k.keyHash === where.keyHash || k.id === where.id);
    if (!key) return null;
    const client = store.clients.find((c) => c.id === key.clientId);
    return { ...key, client };
  };
  (prisma.apiKey as any).create = async ({ data }: any) => {
    const record = { id: data.id || `key-${Date.now()}-${Math.random().toString(36).substring(7)}`, ...data };
    store.apiKeys.push(record);
    return record;
  };
  (prisma.apiKey as any).update = async ({ where, data }: any) => {
    const key = store.apiKeys.find((k) => k.id === where.id || k.keyHash === where.keyHash);
    if (key) {
      Object.assign(key, data);
      return key;
    }
    return null;
  };

  (prisma.user as any).findUnique = async ({ where }: any) => {
    return store.users.find((u) => u.id === where.id || u.email === where.email) || null;
  };
  (prisma.user as any).create = async ({ data }: any) => {
    const record = { id: data.id || `usr-${Date.now()}-${Math.random().toString(36).substring(7)}`, ...data };
    store.users.push(record);
    return record;
  };

  (prisma.userSession as any).findUnique = async ({ where }: any) => {
    const session = store.userSessions.find((s) => s.tokenHash === where.tokenHash || s.id === where.id);
    if (!session) return null;
    const user = store.users.find((u) => u.id === session.userId);
    return { ...session, user };
  };
  (prisma.userSession as any).create = async ({ data }: any) => {
    const record = { id: data.id || `ses-${Date.now()}-${Math.random().toString(36).substring(7)}`, ...data };
    store.userSessions.push(record);
    return record;
  };

  (prisma.emailContact as any).findFirst = async ({ where }: any) => {
    return store.contacts.find((c) => {
      if (where.id && c.id !== where.id) return false;
      if (where.clientId && c.clientId !== where.clientId) return false;
      if (where.normalizedEmail && c.normalizedEmail !== where.normalizedEmail) return false;
      return true;
    }) || null;
  };
  (prisma.emailContact as any).create = async ({ data }: any) => {
    const record = { id: data.id || `ct-${Date.now()}-${Math.random().toString(36).substring(7)}`, ...data };
    store.contacts.push(record);
    return record;
  };

  (prisma.emailSuppression as any).findFirst = async ({ where }: any) => {
    return store.suppressions.find((s) => {
      if (where.clientId && s.clientId !== where.clientId) return false;
      if (where.email && s.email !== where.email) return false;
      return true;
    }) || null;
  };
  (prisma.emailSuppression as any).findUnique = async ({ where }: any) => {
    if (where.clientId_normalizedEmail) {
      const { clientId, normalizedEmail } = where.clientId_normalizedEmail;
      return store.suppressions.find((s) => s.clientId === clientId && s.email === normalizedEmail) || null;
    }
    return null;
  };
  (prisma.emailSuppression as any).create = async ({ data }: any) => {
    const record = { id: data.id || `sup-${Date.now()}-${Math.random().toString(36).substring(7)}`, ...data };
    store.suppressions.push(record);
    return record;
  };

  (prisma.emailTemplate as any).findFirst = async ({ where }: any) => {
    const t = store.templates.find((tpl) => tpl.id === where.id && (!where.clientId || tpl.clientId === where.clientId));
    if (!t) return null;
    const versions = store.templateVersions.filter((v) => v.templateId === t.id);
    const activeVersion = versions.find((v) => v.status === "ACTIVE") || versions[0] || null;
    return { ...t, versions, activeVersion };
  };
  (prisma.emailTemplate as any).findUnique = (prisma.emailTemplate as any).findFirst;
  (prisma.emailTemplate as any).create = async ({ data }: any) => {
    const record = { id: data.id || `tpl-${Date.now()}-${Math.random().toString(36).substring(7)}`, ...data };
    store.templates.push(record);
    return record;
  };

  (prisma.emailTemplateVersion as any).findFirst = async ({ where }: any) => {
    const version = store.templateVersions.find((v) => {
      if (where.id && v.id !== where.id) return false;
      if (where.templateId && v.templateId !== where.templateId) return false;
      if (where.template?.clientId) {
        const tpl = store.templates.find((t) => t.id === v.templateId);
        if (!tpl || tpl.clientId !== where.template.clientId) return false;
      }
      return true;
    });
    if (!version) return null;
    const template = store.templates.find((t) => t.id === version.templateId);
    return { ...version, template };
  };
  (prisma.emailTemplateVersion as any).create = async ({ data }: any) => {
    const record = { id: data.id || `ver-${Date.now()}-${Math.random().toString(36).substring(7)}`, ...data };
    store.templateVersions.push(record);
    return record;
  };

  (prisma.emailList as any).findFirst = async ({ where }: any) => {
    return store.lists.find((l) => l.id === where.id && (!where.clientId || l.clientId === where.clientId)) || null;
  };
  (prisma.emailList as any).create = async ({ data }: any) => {
    const record = { id: data.id || `lst-${Date.now()}-${Math.random().toString(36).substring(7)}`, ...data };
    store.lists.push(record);
    return record;
  };

  (prisma.emailSegment as any).findFirst = async ({ where }: any) => {
    return store.segments.find((s) => s.id === where.id && (!where.clientId || s.clientId === where.clientId)) || null;
  };
  (prisma.emailSegment as any).create = async ({ data }: any) => {
    const record = { id: data.id || `seg-${Date.now()}-${Math.random().toString(36).substring(7)}`, ...data };
    store.segments.push(record);
    return record;
  };

  (prisma.emailSenderIdentity as any).findFirst = async ({ where }: any) => {
    return store.senderIdentities.find((s) => s.id === where.id && (!where.clientId || s.clientId === where.clientId)) || null;
  };
  (prisma.emailSenderIdentity as any).create = async ({ data }: any) => {
    const record = { id: data.id || `snd-${Date.now()}-${Math.random().toString(36).substring(7)}`, ...data };
    store.senderIdentities.push(record);
    return record;
  };

  (prisma.emailCampaign as any).findFirst = async ({ where }: any) => {
    const c = store.campaigns.find((cmp) => cmp.id === where.id && (!where.clientId || cmp.clientId === where.clientId));
    if (!c) return null;
    const templateVersion = store.templateVersions.find((v) => v.id === c.templateVersionId) || null;
    return { ...c, templateVersion };
  };
  (prisma.emailCampaign as any).findUnique = (prisma.emailCampaign as any).findFirst;
  (prisma.emailCampaign as any).findMany = async ({ where }: any) => {
    return store.campaigns.filter((c) => !where?.clientId || c.clientId === where.clientId);
  };
  (prisma.emailCampaign as any).create = async ({ data }: any) => {
    const record = { id: data.id || `cmp-${Date.now()}-${Math.random().toString(36).substring(7)}`, ...data };
    store.campaigns.push(record);
    return record;
  };
  (prisma.emailCampaign as any).update = async ({ where, data }: any) => {
    const idx = store.campaigns.findIndex((c) => c.id === where.id);
    if (idx === -1) throw new Error("Campaign not found");
    store.campaigns[idx] = { ...store.campaigns[idx], ...data };
    return store.campaigns[idx];
  };

  (prisma.emailDelivery as any).findUnique = async ({ where }: any) => {
    return store.deliveries.find((d) => d.id === where.id) || null;
  };
  (prisma.emailDelivery as any).findFirst = async ({ where }: any) => {
    return store.deliveries.find((d) => {
      if (where.id && d.id !== where.id) return false;
      if (where.clientId && d.clientId !== where.clientId) return false;
      if (where.idempotencyKey && d.idempotencyKey !== where.idempotencyKey) return false;
      if (where.to && d.to !== where.to) return false;
      return true;
    }) || null;
  };
  (prisma.emailDelivery as any).create = async ({ data }: any) => {
    if (data.idempotencyKey) {
      const existing = store.deliveries.find(
        (d) => d.clientId === data.clientId && d.idempotencyKey === data.idempotencyKey
      );
      if (existing) {
        const error: any = new Error("Unique constraint failed on the fields: (`clientId`,`idempotencyKey`)");
        error.code = "P2002";
        throw error;
      }
    }
    const record = {
      id: data.id || `del-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      attemptCount: 0,
      createdAt: new Date(),
      ...data,
    };
    store.deliveries.push(record);
    return record;
  };
  (prisma.emailDelivery as any).updateMany = async ({ where, data }: any) => {
    let count = 0;
    for (let i = 0; i < store.deliveries.length; i++) {
      const d = store.deliveries[i];
      if (where.id && d.id !== where.id) continue;
      if (where.status) {
        if (where.status.in && !where.status.in.includes(d.status)) continue;
        if (typeof where.status === "string" && d.status !== where.status) continue;
      }
      store.deliveries[i] = {
        ...d,
        ...data,
        attemptCount: data.attemptCount?.increment ? (d.attemptCount || 0) + data.attemptCount.increment : d.attemptCount,
      };
      count++;
    }
    return { count };
  };
  (prisma.emailDelivery as any).count = async ({ where }: any) => {
    return store.deliveries.filter((d) => {
      if (where.clientId && d.clientId !== where.clientId) return false;
      if (where.idempotencyKey && d.idempotencyKey !== where.idempotencyKey) return false;
      return true;
    }).length;
  };

  (prisma.emailProviderConfig as any).findFirst = async () => null;
}

async function runHardeningSuite() {
  console.log("==================================================================");
  console.log("🚀 RUNNING EMAIL PLATFORM E2E HARDENING & CORRECTNESS SUITE");
  console.log("==================================================================\n");

  setupHardeningMocks();

  const runSuffix = crypto.randomBytes(4).toString("hex");

  // Setup Tenants
  const tenantAlpha = await prisma.apiClient.create({
    data: { name: `Tenant Alpha ${runSuffix}` },
  });
  const tenantBeta = await prisma.apiClient.create({
    data: { name: `Tenant Beta ${runSuffix}` },
  });

  // Setup API Keys
  const alphaKeyGen = generateApiKey();
  await prisma.apiKey.create({
    data: {
      clientId: tenantAlpha.id,
      keyPrefix: alphaKeyGen.keyPrefix,
      keyHash: alphaKeyGen.keyHash,
      name: "Alpha Key",
    },
  });

  const betaKeyGen = generateApiKey();
  await prisma.apiKey.create({
    data: {
      clientId: tenantBeta.id,
      keyPrefix: betaKeyGen.keyPrefix,
      keyHash: betaKeyGen.keyHash,
      name: "Beta Key",
    },
  });

  // Setup Admin & Viewer Users for Tenant Alpha
  const alphaAdminUser = await prisma.user.create({
    data: {
      email: `admin-${runSuffix}@alpha.test`,
      passwordHash: "dummyHash",
      role: "ADMIN",
      active: true,
    },
  });
  const alphaViewerUser = await prisma.user.create({
    data: {
      email: `viewer-${runSuffix}@alpha.test`,
      passwordHash: "dummyHash",
      role: "VIEWER",
      active: true,
    },
  });

  const adminSession = createSessionToken({
    id: alphaAdminUser.id,
    email: alphaAdminUser.email,
    role: "ADMIN",
  });
  await prisma.userSession.create({
    data: {
      tokenHash: hashSessionToken(adminSession.token),
      userId: alphaAdminUser.id,
      expiresAt: new Date(adminSession.expiresAt),
    },
  });

  const viewerSession = createSessionToken({
    id: alphaViewerUser.id,
    email: alphaViewerUser.email,
    role: "VIEWER",
  });
  await prisma.userSession.create({
    data: {
      tokenHash: hashSessionToken(viewerSession.token),
      userId: alphaViewerUser.id,
      expiresAt: new Date(viewerSession.expiresAt),
    },
  });

  const helperRequest = (
    url: string,
    method = "POST",
    body?: unknown,
    authType: "BEARER" | "ADMIN_SESSION" | "VIEWER_SESSION" | "NONE" = "BEARER",
    customKey = alphaKeyGen.rawKey,
    headers: Record<string, string> = {}
  ) => {
    const reqHeaders: Record<string, string> = { ...headers };
    if (body !== undefined) {
      reqHeaders["content-type"] = "application/json";
    }

    if (authType === "BEARER") {
      reqHeaders["authorization"] = `Bearer ${customKey}`;
    } else if (authType === "ADMIN_SESSION") {
      reqHeaders["cookie"] = `whatsapp_hub_session=${encodeURIComponent(adminSession.token)}`;
      reqHeaders["x-client-id"] = tenantAlpha.id;
    } else if (authType === "VIEWER_SESSION") {
      reqHeaders["cookie"] = `whatsapp_hub_session=${encodeURIComponent(viewerSession.token)}`;
      reqHeaders["x-client-id"] = tenantAlpha.id;
    }

    return new NextRequest(`http://localhost:3000${url}`, {
      method,
      headers: reqHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  // -------------------------------------------------------------------------
  // 1. Public Transactional API -> DB -> Queue
  // -------------------------------------------------------------------------
  console.log("--- [1] Public Transactional API -> DB -> Queue ---");
  const txnPayload = {
    type: "TRANSACTIONAL",
    to: `user-${runSuffix}@example.test`,
    subject: "Order Confirmation #54321",
    text: "Your order is confirmed",
  };

  const txnRes = await sendEmailRoute(helperRequest("/api/v1/email/send", "POST", txnPayload));
  const txnJson = await txnRes.json();
  if (txnRes.status !== 202) {
    console.error("DEBUG txnRes failed:", txnRes.status, txnJson);
  }
  testAssert(txnRes.status === 202, "Transactional send returns HTTP 202 Accepted");

  const txnData = txnJson.data;
  testAssert(!!txnData.deliveryId, "Response contains deliveryId");
  testAssert(txnData.category === "TRANSACTIONAL", "Response category is TRANSACTIONAL");

  const txnDelivery = await prisma.emailDelivery.findUnique({
    where: { id: txnData.deliveryId },
  });
  testAssert(txnDelivery !== null, "Authoritative EmailDelivery record exists in DB");
  testAssert(txnDelivery?.status === EmailDeliveryStatus.QUEUED, "Initial delivery status is QUEUED");
  testAssert(txnDelivery?.clientId === tenantAlpha.id, "Delivery scoped to correct tenant");

  const txnQueue = getTransactionalQueue();
  const txnJob = await txnQueue.getJob(getTransactionalJobId(txnData.deliveryId));
  testAssert(txnJob !== null && txnJob !== undefined, "Job enqueued in transactional queue");
  testAssert(txnJob?.name === JOB_NAMES.SEND_TRANSACTIONAL, "Job name is send-transactional");
  testAssert(txnJob?.data.deliveryId === txnData.deliveryId, "Job carries authoritative deliveryId");

  // -------------------------------------------------------------------------
  // 2. Public Promotional API -> DB -> Correct Queue -> Worker
  // -------------------------------------------------------------------------
  console.log("\n--- [2] Public Promotional API -> DB -> Correct Queue -> Worker ---");
  const promoEmail = `marketing-${runSuffix}@example.test`;

  // Contact with marketing consent
  const contact = await prisma.emailContact.create({
    data: {
      clientId: tenantAlpha.id,
      email: promoEmail,
      normalizedEmail: promoEmail.toLowerCase().trim(),
      hasMarketingConsent: true,
      status: "SUBSCRIBED",
    },
  });

  const promoPayload = {
    type: "PROMOTIONAL",
    to: promoEmail,
    subject: "Exclusive Promotional Offer",
    text: "Enjoy 20% off your next purchase!",
  };

  const promoRes = await sendEmailRoute(helperRequest("/api/v1/email/send", "POST", promoPayload));
  testAssert(promoRes.status === 202, "Promotional send returns HTTP 202 Accepted");

  const promoData = (await promoRes.json()).data;
  testAssert(!!promoData.deliveryId, "Response contains promotional deliveryId");
  testAssert(promoData.category === "PROMOTIONAL", "Response category is PROMOTIONAL");

  const promoDelivery = await prisma.emailDelivery.findUnique({
    where: { id: promoData.deliveryId },
  });
  testAssert(promoDelivery?.status === EmailDeliveryStatus.QUEUED, "Promotional delivery persisted as QUEUED");
  testAssert(!promoDelivery?.campaignRecipientId, "CRITICAL: No fake campaign recipient created");

  const campQueue = getCampaignQueue();
  const promoJob = await campQueue.getJob(getPromotionalJobId(promoData.deliveryId));
  testAssert(promoJob !== null && promoJob !== undefined, "Promotional job enqueued in BullMQ campaign queue");
  testAssert(promoJob?.name === JOB_NAMES.SEND_PROMOTIONAL, "Job name is send-promotional");

  // Worker Execution: Process Promotional Job
  const mockProvider = new MockHardeningProvider();
  const workerJob = {
    id: getPromotionalJobId(promoData.deliveryId),
    name: JOB_NAMES.SEND_PROMOTIONAL,
    data: {
      deliveryId: promoData.deliveryId,
      clientId: tenantAlpha.id,
      category: "PROMOTIONAL",
    },
  } as unknown as Job<PromotionalJobData>;

  const workerResult = await processPromotionalDeliveryJob(workerJob, {
    providerOverride: mockProvider,
  });
  testAssert(workerResult.success === true, "Worker processed promotional delivery successfully");

  const updatedDelivery = await prisma.emailDelivery.findUnique({
    where: { id: promoData.deliveryId },
  });
  testAssert(updatedDelivery?.status === EmailDeliveryStatus.SENT, "Delivery transitioned to SENT");
  testAssert(updatedDelivery?.sentAt !== null, "Delivery sentAt timestamp populated");

  // Verify RFC 8058 One-Click Unsubscribe Headers attached
  const sentReq = mockProvider.sentRequests[0];
  testAssert(
    sentReq?.headers?.["List-Unsubscribe"] !== undefined,
    "Worker attached List-Unsubscribe header"
  );
  testAssert(
    sentReq?.headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click",
    "Worker attached RFC 8058 List-Unsubscribe-Post header"
  );

  // Suppression enforcement in worker
  await prisma.emailSuppression.create({
    data: {
      clientId: tenantAlpha.id,
      email: promoEmail.toLowerCase().trim(),
      reason: EmailSuppressionReason.MANUAL,
    },
  });

  const suppressedDelivery = await prisma.emailDelivery.create({
    data: {
      clientId: tenantAlpha.id,
      category: EmailType.PROMOTIONAL,
      providerType: EmailProviderType.MOCK,
      from: "marketing@alpha.test",
      to: promoEmail,
      subject: "Suppressed Test",
      status: EmailDeliveryStatus.QUEUED,
    },
  });

  let workerThrewSuppression = false;
  try {
    await processPromotionalDeliveryJob(
      {
        id: `job-supp-${suppressedDelivery.id}`,
        name: JOB_NAMES.SEND_PROMOTIONAL,
        data: {
          deliveryId: suppressedDelivery.id,
          clientId: tenantAlpha.id,
          category: "PROMOTIONAL",
        },
      } as unknown as Job<PromotionalJobData>,
      { providerOverride: mockProvider }
    );
  } catch (err) {
    workerThrewSuppression = err instanceof UnrecoverableError;
  }
  testAssert(workerThrewSuppression, "Worker threw UnrecoverableError for suppressed recipient");

  const finalSuppDelivery = await prisma.emailDelivery.findUnique({
    where: { id: suppressedDelivery.id },
  });
  testAssert(
    finalSuppDelivery?.status === EmailDeliveryStatus.FAILED &&
      finalSuppDelivery?.errorCode === "RECIPIENT_SUPPRESSED",
    "Suppressed delivery updated to FAILED with RECIPIENT_SUPPRESSED"
  );

  // Consent enforcement in worker
  const noConsentEmail = `noconsent-${runSuffix}@example.test`;
  await prisma.emailContact.create({
    data: {
      clientId: tenantAlpha.id,
      email: noConsentEmail,
      normalizedEmail: noConsentEmail.toLowerCase().trim(),
      hasMarketingConsent: false,
      status: "SUBSCRIBED",
    },
  });

  const noConsentDelivery = await prisma.emailDelivery.create({
    data: {
      clientId: tenantAlpha.id,
      category: EmailType.PROMOTIONAL,
      providerType: EmailProviderType.MOCK,
      from: "marketing@alpha.test",
      to: noConsentEmail,
      subject: "No Consent Test",
      status: EmailDeliveryStatus.QUEUED,
    },
  });

  let workerThrewConsent = false;
  try {
    await processPromotionalDeliveryJob(
      {
        id: `job-noconsent-${noConsentDelivery.id}`,
        name: JOB_NAMES.SEND_PROMOTIONAL,
        data: {
          deliveryId: noConsentDelivery.id,
          clientId: tenantAlpha.id,
          category: "PROMOTIONAL",
        },
      } as unknown as Job<PromotionalJobData>,
      { providerOverride: mockProvider }
    );
  } catch (err) {
    workerThrewConsent = err instanceof UnrecoverableError;
  }
  testAssert(workerThrewConsent, "Worker threw UnrecoverableError for contact without marketing consent");

  const finalConsentDelivery = await prisma.emailDelivery.findUnique({
    where: { id: noConsentDelivery.id },
  });
  testAssert(
    finalConsentDelivery?.status === EmailDeliveryStatus.FAILED &&
      finalConsentDelivery?.errorCode === "MARKETING_CONSENT_REQUIRED",
    "No-consent delivery updated to FAILED with MARKETING_CONSENT_REQUIRED"
  );

  // -------------------------------------------------------------------------
  // 3. Duplicate Idempotency Key
  // -------------------------------------------------------------------------
  console.log("\n--- [3] Duplicate Idempotency Key ---");
  const testIdempotencyKey = `idem-${runSuffix}-${Date.now()}`;
  const idemPayload = {
    type: "TRANSACTIONAL",
    to: `idem-${runSuffix}@example.test`,
    subject: "Invoice #1001",
    text: "Your invoice is ready",
  };

  const firstRes = await sendEmailRoute(
    helperRequest("/api/v1/email/send", "POST", idemPayload, "BEARER", alphaKeyGen.rawKey, {
      "idempotency-key": testIdempotencyKey,
    })
  );
  testAssert(firstRes.status === 202, "Initial idempotent request returns 202");
  const firstDeliveryId = (await firstRes.json()).data.deliveryId;

  const secondRes = await sendEmailRoute(
    helperRequest("/api/v1/email/send", "POST", idemPayload, "BEARER", alphaKeyGen.rawKey, {
      "idempotency-key": testIdempotencyKey,
    })
  );
  testAssert(secondRes.status === 200, "Duplicate request with same idempotency key returns HTTP 200");
  const secondData = (await secondRes.json()).data;
  testAssert(secondData.deduplicated === true, "Duplicate response indicates deduplicated: true");
  testAssert(secondData.deliveryId === firstDeliveryId, "Duplicate response returns identical deliveryId");

  const countDeliveries = await prisma.emailDelivery.count({
    where: { clientId: tenantAlpha.id, idempotencyKey: testIdempotencyKey },
  });
  testAssert(countDeliveries === 1, "Exactly one delivery record persisted for idempotency key");

  // -------------------------------------------------------------------------
  // 4. Redis Enqueue Failure Handling (Honest Failures)
  // -------------------------------------------------------------------------
  console.log("\n--- [4] Redis Enqueue Failure Handling ---");
  const origTxnAdd = txnQueue.add;
  (txnQueue as any).add = async () => {
    throw new Error("Redis cluster node unreachable");
  };

  const honestFailRes = await sendEmailRoute(
    helperRequest("/api/v1/email/send", "POST", {
      type: "TRANSACTIONAL",
      to: `honest-fail-${runSuffix}@example.test`,
      subject: "Failure Test",
      text: "Testing failure",
    })
  );
  txnQueue.add = origTxnAdd;

  testAssert(honestFailRes.status === 500, "API returns HTTP 500 on Redis failure (no fake 202)");
  const honestFailBody = await honestFailRes.json();
  testAssert(honestFailBody.error?.code === "QUEUE_ERROR", "API returns QUEUE_ERROR code");

  const failedDelivery = await prisma.emailDelivery.findFirst({
    where: { clientId: tenantAlpha.id, to: `honest-fail-${runSuffix}@example.test` },
  });
  testAssert(failedDelivery?.status === EmailDeliveryStatus.FAILED, "Durable DB delivery marked as FAILED");
  testAssert(
    failedDelivery?.errorCode === "QUEUE_ENQUEUE_FAILED",
    "Delivery errorCode is QUEUE_ENQUEUE_FAILED"
  );

  // Honest failure in EmailCampaignService.scheduleCampaign
  const schedTemplate = await prisma.emailTemplate.create({
    data: {
      clientId: tenantAlpha.id,
      name: `Sched Template ${runSuffix}`,
      type: "CAMPAIGN",
    },
  });
  const schedVersion = await prisma.emailTemplateVersion.create({
    data: {
      templateId: schedTemplate.id,
      version: 1,
      subject: "Scheduled Campaign Subject",
      htmlContent: "<p>Hello</p>",
      status: "ACTIVE",
    },
  });
  const schedCampaign = await prisma.emailCampaign.create({
    data: {
      clientId: tenantAlpha.id,
      name: `Sched Campaign ${runSuffix}`,
      templateVersionId: schedVersion.id,
      status: EmailCampaignStatus.DRAFT,
    },
  });

  const origCampAdd = campQueue.add;
  (campQueue as any).add = async () => {
    throw new Error("Redis connection closed");
  };

  let scheduleThrew = false;
  try {
    await EmailCampaignService.scheduleCampaign(
      tenantAlpha.id,
      schedCampaign.id,
      new Date(Date.now() + 3600000)
    );
  } catch (err: any) {
    scheduleThrew = err.message.includes("Failed to enqueue scheduled campaign trigger");
  }
  campQueue.add = origCampAdd;

  testAssert(scheduleThrew, "scheduleCampaign threw honest error when queue.add failed");
  const revertedCampaign = await prisma.emailCampaign.findUnique({
    where: { id: schedCampaign.id },
  });
  testAssert(
    revertedCampaign?.status === EmailCampaignStatus.DRAFT && revertedCampaign?.scheduledAt === null,
    "Campaign reverted to DRAFT and scheduledAt cleared upon queue failure"
  );

  // -------------------------------------------------------------------------
  // 5. Campaign Resource Cross-Tenant Rejection (All 5 Resources)
  // -------------------------------------------------------------------------
  console.log("\n--- [5] Campaign Resource Cross-Tenant Rejection ---");

  // Create resources strictly belonging to Tenant Beta
  const betaTemplate = await prisma.emailTemplate.create({
    data: {
      clientId: tenantBeta.id,
      name: `Beta Template ${runSuffix}`,
      type: "CAMPAIGN",
    },
  });

  const betaVersion = await prisma.emailTemplateVersion.create({
    data: {
      templateId: betaTemplate.id,
      version: 1,
      subject: "Beta Template Subject",
      htmlContent: "<p>Beta content</p>",
      status: "ACTIVE",
    },
  });

  const betaList = await prisma.emailList.create({
    data: {
      clientId: tenantBeta.id,
      name: `Beta List ${runSuffix}`,
    },
  });

  const betaSegment = await prisma.emailSegment.create({
    data: {
      clientId: tenantBeta.id,
      name: `Beta Segment ${runSuffix}`,
      criteria: JSON.stringify({ tag: "vip" }),
    },
  });

  const betaSender = await prisma.emailSenderIdentity.create({
    data: {
      clientId: tenantBeta.id,
      email: `sender-${runSuffix}@beta.test`,
      name: "Beta Sender",
    },
  });

  async function assertRejected(fn: () => Promise<unknown>, label: string) {
    try {
      await fn();
      testAssert(false, label, "Expected cross-tenant resource to be rejected but succeeded");
    } catch (err: any) {
      testAssert(
        err.message.includes("does not belong to tenant") || err.message.includes("not found"),
        label,
        err.message
      );
    }
  }

  // Tenant Alpha attempts to create campaign with Tenant Beta's resources
  await assertRejected(
    () =>
      EmailCampaignService.createCampaign(tenantAlpha.id, {
        name: "Cross Template Test",
        templateId: betaTemplate.id,
      }),
    "Reject foreign templateId on create"
  );

  await assertRejected(
    () =>
      EmailCampaignService.createCampaign(tenantAlpha.id, {
        name: "Cross Version Test",
        templateVersionId: betaVersion.id,
      }),
    "Reject foreign templateVersionId on create"
  );

  await assertRejected(
    () =>
      EmailCampaignService.createCampaign(tenantAlpha.id, {
        name: "Cross List Test",
        listId: betaList.id,
      }),
    "Reject foreign listId on create"
  );

  await assertRejected(
    () =>
      EmailCampaignService.createCampaign(tenantAlpha.id, {
        name: "Cross Segment Test",
        segmentId: betaSegment.id,
      }),
    "Reject foreign segmentId on create"
  );

  await assertRejected(
    () =>
      EmailCampaignService.createCampaign(tenantAlpha.id, {
        name: "Cross Sender Test",
        senderIdentityId: betaSender.id,
      }),
    "Reject foreign senderIdentityId on create"
  );

  // Create valid Alpha campaign
  const alphaCampaign = await EmailCampaignService.createCampaign(tenantAlpha.id, {
    name: "Alpha Valid Campaign",
    templateVersionId: schedVersion.id,
  });

  // Tenant Alpha attempts to update campaign with Tenant Beta's resources
  await assertRejected(
    () =>
      EmailCampaignService.updateCampaign(tenantAlpha.id, alphaCampaign.id, {
        templateVersionId: betaVersion.id,
      }),
    "Reject foreign templateVersionId on update"
  );

  await assertRejected(
    () =>
      EmailCampaignService.updateCampaign(tenantAlpha.id, alphaCampaign.id, {
        listId: betaList.id,
      }),
    "Reject foreign listId on update"
  );

  await assertRejected(
    () =>
      EmailCampaignService.updateCampaign(tenantAlpha.id, alphaCampaign.id, {
        segmentId: betaSegment.id,
      }),
    "Reject foreign segmentId on update"
  );

  await assertRejected(
    () =>
      EmailCampaignService.updateCampaign(tenantAlpha.id, alphaCampaign.id, {
        senderIdentityId: betaSender.id,
      }),
    "Reject foreign senderIdentityId on update"
  );

  // -------------------------------------------------------------------------
  // 6. Deterministic Rate Limiting
  // -------------------------------------------------------------------------
  console.log("\n--- [6] Deterministic Rate Limiting ---");
  const rlKey = `test_rl_hardening_${runSuffix}_${Date.now()}`;
  const rl1 = await checkRateLimit(rlKey, 3, 30000);
  testAssert(rl1.success === true && rl1.remaining === 2, "Call 1 within limit succeeds (remaining: 2)");

  const rl2 = await checkRateLimit(rlKey, 3, 30000);
  testAssert(rl2.success === true && rl2.remaining === 1, "Call 2 within limit succeeds (remaining: 1)");

  const rl3 = await checkRateLimit(rlKey, 3, 30000);
  testAssert(rl3.success === true && rl3.remaining === 0, "Call 3 reaches limit boundary (remaining: 0)");

  const rl4 = await checkRateLimit(rlKey, 3, 30000);
  testAssert(rl4.success === false && rl4.remaining === 0, "Call 4 blocked by rate limiter (remaining: 0)");

  // -------------------------------------------------------------------------
  // 7. API Authentication
  // -------------------------------------------------------------------------
  console.log("\n--- [7] API Authentication ---");
  const noAuthRes = await sendEmailRoute(
    helperRequest("/api/v1/email/send", "POST", { type: "TRANSACTIONAL" }, "NONE")
  );
  testAssert(noAuthRes.status === 401, "Missing Authorization header returns HTTP 401 Unauthorized");

  const badKeyRes = await sendEmailRoute(
    helperRequest("/api/v1/email/send", "POST", { type: "TRANSACTIONAL" }, "BEARER", "whub_invalidkey123456789012")
  );
  testAssert(badKeyRes.status === 401, "Invalid API key returns HTTP 401 Unauthorized");

  // -------------------------------------------------------------------------
  // 8. Tenant Boundary Isolation
  // -------------------------------------------------------------------------
  console.log("\n--- [8] Tenant Boundary Isolation ---");
  const crossCampaign = await EmailCampaignService.getCampaignById(tenantBeta.id, alphaCampaign.id);
  testAssert(crossCampaign === null, "Tenant Beta cannot access Tenant Alpha campaign by ID");

  const betaCampaigns = await EmailCampaignService.listCampaigns(tenantBeta.id);
  const alphaFoundInBeta = betaCampaigns.some((c) => c.id === alphaCampaign.id);
  testAssert(!alphaFoundInBeta, "Tenant Alpha campaign does not appear in Tenant Beta campaign list");

  // -------------------------------------------------------------------------
  // 9. ADMIN vs VIEWER RBAC Rules
  // -------------------------------------------------------------------------
  console.log("\n--- [9] ADMIN vs VIEWER RBAC Rules ---");
  // VIEWER attempting campaign mutation -> 403 Forbidden
  const viewerCreateRes = await createCampaignRoute(
    helperRequest("/api/email/campaigns", "POST", { name: "Viewer Campaign" }, "VIEWER_SESSION")
  );
  testAssert(viewerCreateRes.status === 403, "VIEWER role denied campaign creation (HTTP 403)");

  // VIEWER reading campaigns -> 200 OK
  const viewerListRes = await listCampaignsRoute(
    helperRequest("/api/email/campaigns", "GET", undefined, "VIEWER_SESSION")
  );
  testAssert(viewerListRes.status === 200, "VIEWER role permitted read-only campaign listing (HTTP 200)");

  // ADMIN creating campaign -> 201 Created
  const adminCreateRes = await createCampaignRoute(
    helperRequest("/api/email/campaigns", "POST", { name: "Admin Campaign" }, "ADMIN_SESSION")
  );
  testAssert(adminCreateRes.status === 201, "ADMIN role permitted campaign creation (HTTP 201)");

  console.log("\n-------------------------------------------------");
  console.log(`Hardening Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log("-------------------------------------------------\n");

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runHardeningSuite().catch((err) => {
  console.error("Fatal test suite failure:", err);
  process.exit(1);
});
