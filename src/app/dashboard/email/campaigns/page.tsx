"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface CampaignItem {
  id: string;
  name: string;
  description: string | null;
  status: string;
  type: string;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  bouncedCount: number;
  scheduledAt: string | null;
  createdAt: string;
}

interface CampaignAnalytics {
  campaignId: string;
  campaignName: string;
  status: string;
  totalRecipients: number;
  sent: number;
  delivered: number;
  failed: number;
  bounced: number;
  complaints: number;
  unsubscribed: number;
  uniqueOpens: number;
  uniqueClicks: number;
  totalOpens: number;
  totalClicks: number;
  rates: {
    deliveryRate: number;
    bounceRate: number;
    openRate: number;
    clickRate: number;
    complaintRate: number;
    unsubscribeRate: number;
  };
}

interface ExistingCampaignPreview {
  campaignName: string;
  emailType: string;
  status: string;
  template: {
    id: string;
    version: number;
    subject: string;
  } | null;
  sender: {
    id: string;
    email: string;
    name: string;
  } | null;
  audienceCount: number;
  suppressedCount: number;
  unsubscribedCount: number;
  invalidCount: number;
  eligibleRecipientCount: number;
  scheduledTime: string | null;
}

interface ResourceItem {
  id: string;
  name?: string;
  email?: string;
  isDefault?: boolean;
  verified?: boolean;
  versions?: Array<{ id: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [activeStep, setActiveStep] = useState(1);
  const [actionError, setActionError] = useState<string | null>(null);

  // Available options
  const [lists, setLists] = useState<ResourceItem[]>([]);
  const [segments, setSegments] = useState<ResourceItem[]>([]);
  const [templates, setTemplates] = useState<ResourceItem[]>([]);
  const [senders, setSenders] = useState<ResourceItem[]>([]);

  // Wizard state (7 steps)
  // Step 1: Info
  const [campaignName, setCampaignName] = useState("");
  const [campaignType, setCampaignType] = useState<"PROMOTIONAL" | "TRANSACTIONAL">("PROMOTIONAL");
  const [campaignDescription, setCampaignDescription] = useState("");

  // Step 2: Audience
  const [targetType, setTargetType] = useState<"list" | "segment">("list");
  const [selectedListId, setSelectedListId] = useState("");
  const [selectedSegmentId, setSelectedSegmentId] = useState("");

  // Step 3: Template
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState("");

  // Step 4: Sender
  const [selectedSenderId, setSelectedSenderId] = useState("");

  // Step 5: Preview metrics
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState({
    totalAudience: 0,
    suppressedCount: 0,
    missingConsentCount: 0,
    eligibleCount: 0,
  });

  // Step 6: Schedule
  const [scheduleMode, setScheduleMode] = useState<"now" | "future">("now");
  const [scheduledDateTime, setScheduledDateTime] = useState("");

  // Step 7: Confirmation / Submit
  const [submitting, setSubmitting] = useState(false);

  // Modals for Actions on Existing Campaigns
  const [analyticsModalData, setAnalyticsModalData] = useState<CampaignAnalytics | null>(null);

  const [previewModalData, setPreviewModalData] = useState<ExistingCampaignPreview | null>(null);

  const [testSendCampaignId, setTestSendCampaignId] = useState<string | null>(null);
  const [testSendEmail, setTestSendEmail] = useState("");
  const [testSendStatus, setTestSendStatus] = useState<string | null>(null);
  const [testSendLoading, setTestSendLoading] = useState(false);

  async function loadCampaigns() {
    try {
      const res = await fetch("/api/email/campaigns");
      if (res.ok) {
        const json = await res.json();
        setCampaigns(json.data || []);
      }
    } catch {
      // Safe fallback
    } finally {
      setLoading(false);
    }
  }

  async function loadResources() {
    try {
      const [lRes, sRes, tRes, sndRes] = await Promise.all([
        fetch("/api/email/lists"),
        fetch("/api/email/segments"),
        fetch("/api/email/templates"),
        fetch("/api/admin/email/sender-identities"),
      ]);

      if (lRes.ok) setLists((await lRes.json()).data || []);
      if (sRes.ok) setSegments((await sRes.json()).data || []);
      if (tRes.ok) setTemplates((await tRes.json()).data || []);
      if (sndRes.ok) setSenders((await sndRes.json()).data || []);
    } catch {
      // Safe fallback
    }
  }

  useEffect(() => {
    loadCampaigns();
    loadResources();
  }, []);

  // Real campaign preview calculation via backend audience resolver
  async function calculatePreview() {
    setPreviewLoading(true);
    try {
      const res = await fetch("/api/email/campaigns/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listId: targetType === "list" ? selectedListId || null : null,
          segmentId: targetType === "segment" ? selectedSegmentId || null : null,
          type: campaignType,
        }),
      });

      if (res.ok) {
        const json = await res.json();
        if (json.data) {
          setPreviewData({
            totalAudience: json.data.totalAudience ?? 0,
            suppressedCount: json.data.suppressedCount ?? 0,
            missingConsentCount: json.data.unsubscribedCount ?? 0,
            eligibleCount: json.data.eligibleCount ?? 0,
          });
        }
      }
    } catch {
      // Safe fallback
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleNextStep() {
    if (activeStep === 4) {
      await calculatePreview();
    }
    setActiveStep((prev) => Math.min(7, prev + 1));
  }

  function handlePrevStep() {
    setActiveStep((prev) => Math.max(1, prev - 1));
  }

  async function handleCreateAndDispatch() {
    setSubmitting(true);
    setActionError(null);
    try {
      // 1. Create Campaign
      const createRes = await fetch("/api/email/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: campaignName,
          description: campaignDescription || undefined,
          type: campaignType,
          templateId: selectedTemplateId || undefined,
          templateVersionId: selectedVersionId || undefined,
          listId: targetType === "list" ? selectedListId : null,
          segmentId: targetType === "segment" ? selectedSegmentId : null,
          senderIdentityId: selectedSenderId || null,
          scheduledAt: scheduleMode === "future" && scheduledDateTime ? new Date(scheduledDateTime) : null,
        }),
      });

      if (!createRes.ok) {
        const errJson = await createRes.json();
        throw new Error(errJson.error?.message || "Failed to create campaign");
      }

      const createJson = await createRes.json();
      const campaignId = createJson.data.id;

      // 2. Trigger immediate send or schedule
      if (scheduleMode === "now") {
        const sendRes = await fetch(`/api/email/campaigns/${campaignId}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "now" }),
        });
        if (!sendRes.ok) {
          const sendErr = await sendRes.json();
          throw new Error(sendErr.error?.message || "Failed to trigger campaign send");
        }
      }

      setShowWizard(false);
      resetWizard();
      loadCampaigns();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Error creating campaign");
    } finally {
      setSubmitting(false);
    }
  }

  function resetWizard() {
    setActiveStep(1);
    setCampaignName("");
    setCampaignDescription("");
    setCampaignType("PROMOTIONAL");
    setSelectedListId("");
    setSelectedSegmentId("");
    setSelectedTemplateId("");
    setSelectedVersionId("");
    setSelectedSenderId("");
    setScheduleMode("now");
    setScheduledDateTime("");
    setActionError(null);
  }

  async function handlePause(campaignId: string) {
    try {
      const res = await fetch(`/api/email/campaigns/${campaignId}/pause`, { method: "POST" });
      if (!res.ok) {
        const errJson = await res.json();
        alert(errJson.error?.message || "Failed to pause campaign");
      }
      loadCampaigns();
    } catch {
      // Safe fallback
    }
  }

  async function handleResume(campaignId: string) {
    try {
      const res = await fetch(`/api/email/campaigns/${campaignId}/resume`, { method: "POST" });
      if (!res.ok) {
        const errJson = await res.json();
        alert(errJson.error?.message || "Failed to resume campaign");
      }
      loadCampaigns();
    } catch {
      // Safe fallback
    }
  }

  async function handleCancel(campaignId: string) {
    if (!confirm("Are you sure you want to cancel this campaign? Pending recipients will not be sent.")) return;
    try {
      const res = await fetch(`/api/email/campaigns/${campaignId}/cancel`, { method: "POST" });
      if (!res.ok) {
        const errJson = await res.json();
        alert(errJson.error?.message || "Failed to cancel campaign");
      }
      loadCampaigns();
    } catch {
      // Safe fallback
    }
  }

  async function handleOpenAnalytics(campaignId: string) {
    setAnalyticsModalData(null);
    try {
      const res = await fetch(`/api/email/campaigns/${campaignId}/analytics`);
      if (res.ok) {
        const json = await res.json();
        setAnalyticsModalData(json.data);
      } else {
        const errJson = await res.json();
        alert(errJson.error?.message || "Failed to load campaign analytics");
      }
    } catch {
      // Safe fallback
    }
  }

  async function handleOpenPreview(campaignId: string) {
    setPreviewModalData(null);
    try {
      const res = await fetch(`/api/email/campaigns/${campaignId}/preview`);
      if (res.ok) {
        const json = await res.json();
        setPreviewModalData(json.data);
      } else {
        const errJson = await res.json();
        alert(errJson.error?.message || "Failed to load campaign preview");
      }
    } catch {
      // Safe fallback
    }
  }

  async function handleSendTest(e: React.FormEvent) {
    e.preventDefault();
    if (!testSendCampaignId || !testSendEmail.trim()) return;
    setTestSendLoading(true);
    setTestSendStatus(null);
    try {
      const res = await fetch(`/api/email/campaigns/${testSendCampaignId}/test-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testEmail: testSendEmail.trim() }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setTestSendStatus(`Test email successfully delivered to ${json.data.sentTo} (Message ID: ${json.data.providerMessageId || "mock-ok"})`);
      } else {
        setTestSendStatus(`Failed: ${json.error?.message || "Could not dispatch test email"}`);
      }
    } catch (err) {
      setTestSendStatus(`Error: ${err instanceof Error ? err.message : "Network error"}`);
    } finally {
      setTestSendLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Email Campaigns</h1>
          <p className="text-sm text-zinc-400">
            Lifecycle state machine with frozen audience snapshots, verified sender identities, and authoritative analytics.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/email"
            className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm font-medium transition"
          >
            &larr; Overview
          </Link>
          <button
            onClick={() => {
              resetWizard();
              setShowWizard(true);
            }}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
          >
            + Campaign Wizard
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-[300px]">
          <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : campaigns.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-12 text-center">
          <p className="text-zinc-400">No campaigns launched yet.</p>
          <button
            onClick={() => {
              resetWizard();
              setShowWizard(true);
            }}
            className="mt-4 px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
          >
            Launch First Campaign
          </button>
        </div>
      ) : (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-zinc-300">
              <thead className="bg-zinc-800/40 text-xs uppercase text-zinc-400 border-b border-zinc-800">
                <tr>
                  <th className="px-5 py-3">Campaign</th>
                  <th className="px-5 py-3">Type</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Recipients</th>
                  <th className="px-5 py-3">Delivered</th>
                  <th className="px-5 py-3">Bounced</th>
                  <th className="px-5 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {campaigns.map((camp) => (
                  <tr key={camp.id} className="hover:bg-zinc-800/20 transition">
                    <td className="px-5 py-3.5 font-medium text-white">{camp.name}</td>
                    <td className="px-5 py-3.5 text-xs text-zinc-400">{camp.type}</td>
                    <td className="px-5 py-3.5">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium border ${
                        camp.status === "RUNNING"
                          ? "bg-sky-500/10 text-sky-400 border-sky-500/20 animate-pulse"
                          : camp.status === "COMPLETED"
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                          : camp.status === "PAUSED"
                          ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                          : camp.status === "CANCELLED"
                          ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                          : "bg-zinc-800 text-zinc-300 border-zinc-700"
                      }`}>
                        {camp.status}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">{camp.totalRecipients}</td>
                    <td className="px-5 py-3.5 text-emerald-400">{camp.deliveredCount}</td>
                    <td className="px-5 py-3.5 text-amber-400">{camp.bouncedCount}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <button
                          onClick={() => handleOpenAnalytics(camp.id)}
                          className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-sky-400 rounded font-medium transition"
                          title="View Authoritative Campaign Analytics"
                        >
                          Analytics
                        </button>
                        <button
                          onClick={() => handleOpenPreview(camp.id)}
                          className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded font-medium transition"
                          title="Inspect Campaign Details & Snapshot"
                        >
                          Preview
                        </button>
                        <button
                          onClick={() => {
                            setTestSendCampaignId(camp.id);
                            setTestSendEmail("");
                            setTestSendStatus(null);
                          }}
                          className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded font-medium transition"
                          title="Send a real test email with bound template"
                        >
                          Test Send
                        </button>
                        {camp.status === "RUNNING" && (
                          <button
                            onClick={() => handlePause(camp.id)}
                            className="px-2 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 rounded font-medium border border-amber-500/20 transition"
                          >
                            Pause
                          </button>
                        )}
                        {camp.status === "PAUSED" && (
                          <button
                            onClick={() => handleResume(camp.id)}
                            className="px-2 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 rounded font-medium border border-emerald-500/20 transition"
                          >
                            Resume
                          </button>
                        )}
                        {(camp.status === "RUNNING" || camp.status === "SCHEDULED" || camp.status === "PAUSED") && (
                          <button
                            onClick={() => handleCancel(camp.id)}
                            className="px-2 py-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 rounded font-medium border border-rose-500/20 transition"
                          >
                            Cancel
                          </button>
                        )}
                        <Link
                          href={`/dashboard/email/deliveries`}
                          className="text-zinc-500 hover:text-zinc-300 transition"
                          title="Inspect individual delivery status"
                        >
                          Deliveries &rarr;
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 7-Step Campaign Wizard Modal */}
      {showWizard && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-xl w-full p-6 space-y-5">
            {/* Step Header */}
            <div>
              <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
                <span>Campaign Wizard</span>
                <span>Step {activeStep} of 7</span>
              </div>
              <h2 className="text-lg font-bold text-white">
                {activeStep === 1 && "1. Campaign Information"}
                {activeStep === 2 && "2. Target Audience"}
                {activeStep === 3 && "3. Template Selection"}
                {activeStep === 4 && "4. Sender Identity"}
                {activeStep === 5 && "5. Authoritative Audience Preview"}
                {activeStep === 6 && "6. Schedule Execution"}
                {activeStep === 7 && "7. Final Confirmation"}
              </h2>
            </div>

            {actionError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs">
                {actionError}
              </div>
            )}

            {/* Step 1: Info */}
            {activeStep === 1 && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Campaign Name</label>
                  <input
                    type="text"
                    required
                    value={campaignName}
                    onChange={(e) => setCampaignName(e.target.value)}
                    placeholder="e.g. Black Friday Special 2026"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Campaign Type</label>
                  <select
                    value={campaignType}
                    onChange={(e) => setCampaignType(e.target.value as "PROMOTIONAL" | "TRANSACTIONAL")}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  >
                    <option value="PROMOTIONAL">PROMOTIONAL (Requires marketing consent & RFC 8058)</option>
                    <option value="TRANSACTIONAL">TRANSACTIONAL (Essential account updates)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Description (Optional)</label>
                  <textarea
                    rows={2}
                    value={campaignDescription}
                    onChange={(e) => setCampaignDescription(e.target.value)}
                    placeholder="Internal campaign objective..."
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>
            )}

            {/* Step 2: Audience */}
            {activeStep === 2 && (
              <div className="space-y-3">
                <div className="flex gap-4 border-b border-zinc-800 pb-2">
                  <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-300">
                    <input
                      type="radio"
                      name="targetType"
                      checked={targetType === "list"}
                      onChange={() => setTargetType("list")}
                    />
                    <span>Static List</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-300">
                    <input
                      type="radio"
                      name="targetType"
                      checked={targetType === "segment"}
                      onChange={() => setTargetType("segment")}
                    />
                    <span>Dynamic Segment</span>
                  </label>
                </div>

                {targetType === "list" ? (
                  <div>
                    <label className="text-xs text-zinc-400 block mb-1">Select List</label>
                    <select
                      value={selectedListId}
                      onChange={(e) => setSelectedListId(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                    >
                      <option value="">-- Choose List --</option>
                      {lists.map((l) => (
                        <option key={l.id} value={l.id}>{l.name}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div>
                    <label className="text-xs text-zinc-400 block mb-1">Select Segment</label>
                    <select
                      value={selectedSegmentId}
                      onChange={(e) => setSelectedSegmentId(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                    >
                      <option value="">-- Choose Segment --</option>
                      {segments.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* Step 3: Template */}
            {activeStep === 3 && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Select Template</label>
                  <select
                    value={selectedTemplateId}
                    onChange={(e) => {
                      setSelectedTemplateId(e.target.value);
                      const t = templates.find((tpl) => tpl.id === e.target.value);
                      if (t?.versions?.[0]) setSelectedVersionId(t.versions[0].id);
                    }}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  >
                    <option value="">-- Choose Template --</option>
                    {templates.map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                    ))}
                  </select>
                </div>
                {selectedTemplateId && (
                  <p className="text-xs text-zinc-400">
                    Bound to immutable active version. Future edits to this template will not alter this campaign.
                  </p>
                )}
              </div>
            )}

            {/* Step 4: Sender Selection corresponding to actual worker dispatch */}
            {activeStep === 4 && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Sender Identity</label>
                  <select
                    value={selectedSenderId}
                    onChange={(e) => setSelectedSenderId(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  >
                    <option value="">-- Default Tenant Provider Sender --</option>
                    {senders.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name ? `"${s.name}" <${s.email}>` : s.email} {s.isDefault ? "(Default)" : ""} {s.verified ? "✓" : "(Unverified)"}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800 text-xs text-zinc-400 space-y-1">
                  <p className="font-semibold text-zinc-300">Worker Sender Resolution:</p>
                  <p>
                    {selectedSenderId ? (
                      senders.find((s) => s.id === selectedSenderId)?.verified ? (
                        <span className="text-emerald-400">✓ Verified Identity: Worker will format From header with exact display name and email.</span>
                      ) : (
                        <span className="text-amber-400">⚠️ Warning: Selected sender identity is not verified. Worker will reject dispatch until verified.</span>
                      )
                    ) : (
                      <span className="text-zinc-400">Worker will automatically resolve the tenant&apos;s active default provider configuration.</span>
                    )}
                  </p>
                </div>
              </div>
            )}

            {/* Step 5: Real Authoritative Audience Preview */}
            {activeStep === 5 && (
              <div className="space-y-3">
                {previewLoading ? (
                  <div className="flex flex-col items-center justify-center p-8 space-y-2">
                    <div className="w-6 h-6 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
                    <span className="text-xs text-zinc-400">Querying authoritative audience metrics...</span>
                  </div>
                ) : (
                  <div className="space-y-3 bg-zinc-950 border border-zinc-800 rounded-xl p-4">
                    <div className="flex items-center justify-between text-sm py-1 border-b border-zinc-800/80">
                      <span className="text-zinc-400">Total Audience Candidates:</span>
                      <span className="font-semibold text-white">{previewData.totalAudience}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm py-1 border-b border-zinc-800/80">
                      <span className="text-zinc-400">Suppressed Recipients (Bounces / Complaints):</span>
                      <span className="font-semibold text-amber-400">-{previewData.suppressedCount}</span>
                    </div>
                    {campaignType === "PROMOTIONAL" && (
                      <div className="flex items-center justify-between text-sm py-1 border-b border-zinc-800/80">
                        <span className="text-zinc-400">Missing Marketing Consent / Unsubscribed:</span>
                        <span className="font-semibold text-rose-400">-{previewData.missingConsentCount}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between text-sm py-1 pt-2 font-medium">
                      <span className="text-white">Eligible Snapshot Recipients:</span>
                      <span className="text-emerald-400 font-bold text-base">{previewData.eligibleCount}</span>
                    </div>
                  </div>
                )}
                <p className="text-[11px] text-zinc-500">
                  Authoritative snapshot calculated directly from PostgreSQL contact lists and suppression registries.
                </p>
              </div>
            )}

            {/* Step 6: Schedule */}
            {activeStep === 6 && (
              <div className="space-y-3">
                <div className="flex gap-4 border-b border-zinc-800 pb-2">
                  <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-300">
                    <input
                      type="radio"
                      name="scheduleMode"
                      checked={scheduleMode === "now"}
                      onChange={() => setScheduleMode("now")}
                    />
                    <span>Send Immediately</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-300">
                    <input
                      type="radio"
                      name="scheduleMode"
                      checked={scheduleMode === "future"}
                      onChange={() => setScheduleMode("future")}
                    />
                    <span>Schedule Future Time</span>
                  </label>
                </div>

                {scheduleMode === "future" && (
                  <div>
                    <label className="text-xs text-zinc-400 block mb-1">Target Date & Time</label>
                    <input
                      type="datetime-local"
                      value={scheduledDateTime}
                      onChange={(e) => setScheduledDateTime(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Step 7: Confirmation */}
            {activeStep === 7 && (
              <div className="space-y-3 bg-zinc-950 border border-zinc-800 rounded-xl p-4 text-sm">
                <div className="flex justify-between py-1 border-b border-zinc-800">
                  <span className="text-zinc-400">Campaign Name:</span>
                  <span className="font-medium text-white">{campaignName}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-zinc-800">
                  <span className="text-zinc-400">Campaign Type:</span>
                  <span className="font-medium text-sky-400">{campaignType}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-zinc-800">
                  <span className="text-zinc-400">Eligible Recipients:</span>
                  <span className="font-bold text-emerald-400">{previewData.eligibleCount}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-zinc-800">
                  <span className="text-zinc-400">Suppressed Filtered:</span>
                  <span className="font-medium text-amber-400">{previewData.suppressedCount}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-zinc-800">
                  <span className="text-zinc-400">Execution Schedule:</span>
                  <span className="font-medium text-zinc-200">
                    {scheduleMode === "now" ? "Immediately on Confirm" : scheduledDateTime}
                  </span>
                </div>
                {campaignType === "PROMOTIONAL" && (
                  <p className="text-xs text-zinc-400 pt-2">
                    🛡️ RFC 8058 One-Click Unsubscribe headers and signed open/click tracking tokens will be automatically injected.
                  </p>
                )}
              </div>
            )}

            {/* Navigation Buttons */}
            <div className="flex items-center justify-between pt-3 border-t border-zinc-800">
              <button
                type="button"
                onClick={activeStep === 1 ? () => setShowWizard(false) : handlePrevStep}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition"
              >
                {activeStep === 1 ? "Cancel" : "Back"}
              </button>

              {activeStep < 7 ? (
                <button
                  type="button"
                  onClick={handleNextStep}
                  disabled={activeStep === 1 && !campaignName.trim()}
                  className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  Next &rarr;
                </button>
              ) : (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={handleCreateAndDispatch}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  {submitting ? "Launching..." : "Confirm & Launch Campaign"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Authoritative Campaign Analytics Modal */}
      {analyticsModalData && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-2xl w-full p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div>
                <h2 className="text-lg font-bold text-white">{analyticsModalData.campaignName}</h2>
                <p className="text-xs text-zinc-400">Authoritative Campaign Analytics</p>
              </div>
              <button
                onClick={() => setAnalyticsModalData(null)}
                className="text-zinc-500 hover:text-white"
              >
                ✕
              </button>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3">
                <p className="text-xs text-zinc-400">Recipients</p>
                <p className="text-xl font-bold text-white mt-1">{analyticsModalData.totalRecipients}</p>
              </div>
              <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3">
                <p className="text-xs text-zinc-400">Delivered</p>
                <p className="text-xl font-bold text-emerald-400 mt-1">{analyticsModalData.delivered}</p>
              </div>
              <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3">
                <p className="text-xs text-zinc-400">Unique Opens</p>
                <p className="text-xl font-bold text-sky-400 mt-1">{analyticsModalData.uniqueOpens}</p>
              </div>
              <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3">
                <p className="text-xs text-zinc-400">Unique Clicks</p>
                <p className="text-xl font-bold text-indigo-400 mt-1">{analyticsModalData.uniqueClicks}</p>
              </div>
            </div>

            {/* Rates Overview */}
            <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 space-y-3">
              <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Performance Rates</h3>
              <div className="space-y-2">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-zinc-400">Open Rate:</span>
                    <span className="text-sky-400 font-bold">{analyticsModalData.rates.openRate}%</span>
                  </div>
                  <div className="w-full bg-zinc-800 rounded-full h-2">
                    <div
                      className="bg-sky-500 h-2 rounded-full"
                      style={{ width: `${Math.min(100, analyticsModalData.rates.openRate)}%` }}
                    ></div>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-zinc-400">Click Rate:</span>
                    <span className="text-indigo-400 font-bold">{analyticsModalData.rates.clickRate}%</span>
                  </div>
                  <div className="w-full bg-zinc-800 rounded-full h-2">
                    <div
                      className="bg-indigo-500 h-2 rounded-full"
                      style={{ width: `${Math.min(100, analyticsModalData.rates.clickRate)}%` }}
                    ></div>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-zinc-400">Delivery Rate:</span>
                    <span className="text-emerald-400 font-bold">{analyticsModalData.rates.deliveryRate}%</span>
                  </div>
                  <div className="w-full bg-zinc-800 rounded-full h-2">
                    <div
                      className="bg-emerald-500 h-2 rounded-full"
                      style={{ width: `${Math.min(100, analyticsModalData.rates.deliveryRate)}%` }}
                    ></div>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-zinc-400">Bounce Rate:</span>
                    <span className="text-amber-400 font-bold">{analyticsModalData.rates.bounceRate}%</span>
                  </div>
                  <div className="w-full bg-zinc-800 rounded-full h-2">
                    <div
                      className="bg-amber-500 h-2 rounded-full"
                      style={{ width: `${Math.min(100, analyticsModalData.rates.bounceRate)}%` }}
                    ></div>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-zinc-800">
              <button
                onClick={() => setAnalyticsModalData(null)}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Existing Campaign Preview Modal */}
      {previewModalData && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div>
                <h2 className="text-lg font-bold text-white">{previewModalData.campaignName}</h2>
                <p className="text-xs text-zinc-400">Campaign Preview & Audience Details</p>
              </div>
              <button
                onClick={() => setPreviewModalData(null)}
                className="text-zinc-500 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 bg-zinc-950 p-4 rounded-xl border border-zinc-800 text-xs">
              <div className="flex justify-between py-1 border-b border-zinc-800">
                <span className="text-zinc-400">Status:</span>
                <span className="text-zinc-200 font-medium">{previewModalData.status}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-800">
                <span className="text-zinc-400">Email Type:</span>
                <span className="text-sky-400 font-medium">{previewModalData.emailType}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-800">
                <span className="text-zinc-400">Template Subject:</span>
                <span className="text-zinc-200 font-medium">{previewModalData.template?.subject || "N/A"}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-800">
                <span className="text-zinc-400">Total Candidates:</span>
                <span className="text-white font-medium">{previewModalData.audienceCount}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-800">
                <span className="text-zinc-400">Suppressed:</span>
                <span className="text-amber-400 font-medium">{previewModalData.suppressedCount}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-800">
                <span className="text-zinc-400">Unsubscribed / Missing Consent:</span>
                <span className="text-rose-400 font-medium">{previewModalData.unsubscribedCount}</span>
              </div>
              <div className="flex justify-between py-1 font-bold text-sm">
                <span className="text-white">Eligible Snapshot Recipients:</span>
                <span className="text-emerald-400">{previewModalData.eligibleRecipientCount}</span>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-zinc-800">
              <button
                onClick={() => setPreviewModalData(null)}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Test Send Modal */}
      {testSendCampaignId && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h2 className="text-lg font-bold text-white">Send Test Campaign Email</h2>
              <button
                onClick={() => setTestSendCampaignId(null)}
                className="text-zinc-500 hover:text-white"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-zinc-400">
              Dispatches a transactional test email rendered with sample variables. Does not create campaign recipient snapshot records or impact campaign telemetry.
            </p>

            <form onSubmit={handleSendTest} className="space-y-3">
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Test Recipient Email</label>
                <input
                  type="email"
                  required
                  placeholder="recipient@example.com"
                  value={testSendEmail}
                  onChange={(e) => setTestSendEmail(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>

              {testSendStatus && (
                <div className={`p-3 rounded-lg text-xs border ${
                  testSendStatus.startsWith("Test email successfully")
                    ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                    : "bg-rose-500/10 border-rose-500/20 text-rose-400"
                }`}>
                  {testSendStatus}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setTestSendCampaignId(null)}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={testSendLoading}
                  className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  {testSendLoading ? "Sending Test..." : "Send Test Email"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
