"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface DomainRecord {
  id: string;
  domain: string;
  verificationStatus: "PENDING" | "VERIFIED" | "FAILED" | "REVOKED";
  verificationToken: string;
  spfStatus: "PENDING" | "VERIFIED" | "MISCONFIGURED" | "FAILED" | "MISSING";
  spfRecord?: string | null;
  dkimStatus: "PENDING" | "VERIFIED" | "MISCONFIGURED" | "FAILED" | "MISSING";
  dkimSelector: string;
  dkimRecord?: string | null;
  dmarcStatus: "PENDING" | "VERIFIED" | "MISCONFIGURED" | "FAILED" | "MISSING";
  dmarcRecord?: string | null;
  dmarcPolicy?: string | null;
  mxStatus: "PENDING" | "VERIFIED" | "MISCONFIGURED" | "FAILED" | "MISSING";
  reputationScore: number;
  checkErrors?: string | null;
  lastCheckedAt?: string | null;
  verifiedAt?: string | null;
}

interface DnsGuidance {
  type: string;
  host: string;
  value: string;
  priority?: number;
  purpose: string;
  description: string;
  recommended: boolean;
}

interface ReputationData {
  score: number;
  grade: "EXCELLENT" | "GOOD" | "FAIR" | "POOR" | "CRITICAL";
  metrics24h: {
    sentCount: number;
    deliveredCount: number;
    bouncedCount: number;
    complaintCount: number;
    bounceRate: number;
    complaintRate: number;
    deliveryRate: number;
  };
  metrics7d: {
    sentCount: number;
    deliveredCount: number;
    bouncedCount: number;
    complaintCount: number;
    bounceRate: number;
    complaintRate: number;
    deliveryRate: number;
  };
  googleYahooCompliance: {
    compliant: boolean;
    checks: {
      spfVerified: boolean;
      dkimVerified: boolean;
      dmarcVerified: boolean;
      complaintRateSafe: boolean;
      oneClickUnsubscribeSupported: boolean;
    };
    missingRequirements: string[];
  };
  factors: {
    authenticationScore: number;
    complaintScore: number;
    bounceScore: number;
    deliveryScore: number;
  };
  actionableAlerts: string[];
}

interface DiagnosticItem {
  id: string;
  recipient: string;
  from: string;
  subject: string;
  status: string;
  type: string;
  failureCategory: string;
  smtpCode: string | null;
  humanSummary: string;
  recommendedRemediation: string;
  rawErrorMessage?: string | null;
  rawErrorCode?: string | null;
  attemptCount: number;
  failedAt: string;
  campaignName: string | null;
}

interface QuotaItem {
  providerConfigId: string;
  providerName: string;
  providerType: string;
  senderEmail: string | null;
  dailyLimit: number;
  sentToday: number;
  remaining: number;
  percentUsed: number;
  hourlyRate: number;
  status: "NORMAL" | "WARNING" | "CRITICAL" | "EXHAUSTED";
  resetAt: string;
}

export default function DeliverabilityDashboardPage() {
  const [activeTab, setActiveTab] = useState<"overview" | "domains" | "diagnostics" | "quotas">("overview");
  const [loading, setLoading] = useState(true);
  const [reputation, setReputation] = useState<ReputationData | null>(null);
  const [domains, setDomains] = useState<DomainRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>([]);
  const [quotas, setQuotas] = useState<QuotaItem[]>([]);
  const [selectedDomainGuidance, setSelectedDomainGuidance] = useState<{ domain: DomainRecord; records: DnsGuidance[] } | null>(null);
  const [newDomainName, setNewDomainName] = useState("");
  const [newProviderType, setNewProviderType] = useState("GMAIL");
  const [newSelector, setNewSelector] = useState("whub");
  const [creatingDomain, setCreatingDomain] = useState(false);
  const [verifyingDomainId, setVerifyingDomainId] = useState<string | null>(null);
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>("ALL");
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [repRes, domRes, diagRes, quotRes] = await Promise.all([
        fetch("/api/admin/email/deliverability/overview"),
        fetch("/api/admin/email/domains"),
        fetch("/api/admin/email/deliverability/diagnostics"),
        fetch("/api/admin/email/deliverability/quotas"),
      ]);

      if (repRes.ok) {
        const json = await repRes.json();
        setReputation(json.data);
      }
      if (domRes.ok) {
        const json = await domRes.json();
        setDomains(json.data || []);
      }
      if (diagRes.ok) {
        const json = await diagRes.json();
        setDiagnostics(json.data?.diagnostics || []);
      }
      if (quotRes.ok) {
        const json = await quotRes.json();
        setQuotas(json.data || []);
      }
    } catch {
      setMessage({ text: "Failed to load deliverability data.", type: "error" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleCreateDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDomainName) return;

    try {
      setCreatingDomain(true);
      const res = await fetch("/api/admin/email/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: newDomainName,
          providerType: newProviderType,
          dkimSelector: newSelector || "whub",
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to add domain");
      }

      setMessage({ text: `Domain '${newDomainName}' added successfully. Configure DNS records below.`, type: "success" });
      setNewDomainName("");
      await fetchData();

      if (json.data?.domain && json.data?.guidance) {
        setSelectedDomainGuidance({
          domain: json.data.domain,
          records: json.data.guidance,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessage({ text: msg, type: "error" });
    } finally {
      setCreatingDomain(false);
    }
  };

  const handleVerifyDomain = async (domainId: string) => {
    try {
      setVerifyingDomainId(domainId);
      const res = await fetch(`/api/admin/email/domains/${domainId}/verify`, {
        method: "POST",
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Verification request failed");
      }

      const result = json.data;
      if (result?.overallStatus === "VERIFIED") {
        setMessage({ text: `Domain ${result.domain} verified successfully!`, type: "success" });
      } else {
        setMessage({ text: `DNS verification check completed. Domain is not fully verified yet: ${result?.tokenVerification?.message || "DNS records missing."}`, type: "error" });
      }

      await fetchData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessage({ text: msg, type: "error" });
    } finally {
      setVerifyingDomainId(null);
    }
  };

  const handleViewGuidance = async (domain: DomainRecord) => {
    try {
      const res = await fetch(`/api/admin/email/domains/${domain.id}`);
      if (res.ok) {
        const json = await res.json();
        setSelectedDomainGuidance({
          domain,
          records: json.data?.guidance || [],
        });
      }
    } catch {
      setMessage({ text: "Failed to load DNS records for domain.", type: "error" });
    }
  };

  const handleDeleteDomain = async (domainId: string, domainName: string) => {
    if (!confirm(`Are you sure you want to remove domain '${domainName}'?`)) return;

    try {
      const res = await fetch(`/api/admin/email/domains/${domainId}`, { method: "DELETE" });
      if (res.ok) {
        setMessage({ text: `Domain '${domainName}' deleted.`, type: "success" });
        if (selectedDomainGuidance?.domain.id === domainId) {
          setSelectedDomainGuidance(null);
        }
        await fetchData();
      }
    } catch {
      setMessage({ text: "Failed to delete domain.", type: "error" });
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(label);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const filteredDiagnostics = selectedCategoryFilter === "ALL"
    ? diagnostics
    : diagnostics.filter((d) => d.failureCategory === selectedCategoryFilter);

  const getDnsBadge = (status: string) => {
    switch (status) {
      case "VERIFIED":
        return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Verified</span>;
      case "MISCONFIGURED":
        return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">Misconfigured</span>;
      case "FAILED":
      case "MISSING":
        return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20">Missing</span>;
      default:
        return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700">Pending</span>;
    }
  };

  const getFailureCategoryBadge = (category: string) => {
    switch (category) {
      case "AUTHENTICATION_FAILED":
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">Auth Failed (SPF/DKIM/DMARC)</span>;
      case "SPAM_BLOCK":
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">Spam / Blocklist</span>;
      case "INVALID_RECIPIENT":
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20">Invalid Recipient</span>;
      case "MAILBOX_FULL":
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-sky-500/10 text-sky-400 border border-sky-500/20">Mailbox Full (Soft)</span>;
      case "DNS_LOOKUP_FAILURE":
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-orange-500/10 text-orange-400 border border-orange-500/20">DNS / MX Failure</span>;
      case "RATE_LIMITED":
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">Throttled / Rate Limit</span>;
      case "TLS_ERROR":
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-pink-500/10 text-pink-400 border border-pink-500/20">TLS Negotiation</span>;
      case "QUOTA_EXCEEDED":
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-500/10 text-red-400 border border-red-500/20">Provider Quota</span>;
      default:
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-zinc-800 text-zinc-300 border border-zinc-700">Unknown Error</span>;
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 90) return "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
    if (score >= 75) return "text-sky-400 border-sky-500/30 bg-sky-500/10";
    if (score >= 50) return "text-amber-400 border-amber-500/30 bg-amber-500/10";
    return "text-rose-400 border-rose-500/30 bg-rose-500/10";
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-white">Email Deliverability & Reputation</h1>
            <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              Provider-Agnostic
            </span>
          </div>
          <p className="text-sm text-zinc-400 mt-1">
            Real-time DNS verification, SPF/DKIM/DMARC health, Google & Yahoo compliance, and failure diagnostics.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              domains.forEach((d) => handleVerifyDomain(d.id));
            }}
            disabled={domains.length === 0}
            className="px-3.5 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 rounded-lg text-xs font-semibold border border-zinc-700 transition flex items-center gap-2"
          >
            <span>🔄 Verify All Domains</span>
          </button>
          <button
            onClick={() => setActiveTab("domains")}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-lg shadow-indigo-600/20 transition flex items-center gap-1.5"
          >
            <span>+ Add Domain</span>
          </button>
        </div>
      </div>

      {/* Navigation Submodule Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 pb-3 text-xs">
        <Link href="/dashboard/email" className="px-3 py-1.5 rounded-lg bg-zinc-900 text-zinc-300 hover:text-white border border-zinc-800 transition">
          Overview
        </Link>
        <Link href="/dashboard/email/campaigns" className="px-3 py-1.5 rounded-lg bg-zinc-900 text-zinc-300 hover:text-white border border-zinc-800 transition">
          Campaigns
        </Link>
        <Link href="/dashboard/email/templates" className="px-3 py-1.5 rounded-lg bg-zinc-900 text-zinc-300 hover:text-white border border-zinc-800 transition">
          Templates
        </Link>
        <Link href="/dashboard/email/contacts" className="px-3 py-1.5 rounded-lg bg-zinc-900 text-zinc-300 hover:text-white border border-zinc-800 transition">
          Contacts & Consent
        </Link>
        <Link href="/dashboard/email/lists" className="px-3 py-1.5 rounded-lg bg-zinc-900 text-zinc-300 hover:text-white border border-zinc-800 transition">
          Lists
        </Link>
        <Link href="/dashboard/email/deliverability" className="px-3 py-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 font-semibold border border-indigo-500/20">
          Deliverability & DNS
        </Link>
        <Link href="/dashboard/email/deliveries" className="px-3 py-1.5 rounded-lg bg-zinc-900 text-zinc-300 hover:text-white border border-zinc-800 transition">
          Deliveries
        </Link>
        <Link href="/dashboard/email/providers" className="px-3 py-1.5 rounded-lg bg-zinc-900 text-zinc-300 hover:text-white border border-zinc-800 transition">
          Providers
        </Link>
        <Link href="/dashboard/email/suppressions" className="px-3 py-1.5 rounded-lg bg-zinc-900 text-zinc-300 hover:text-white border border-zinc-800 transition">
          Suppressions
        </Link>
      </div>

      {/* User Alerts Banner */}
      {message && (
        <div className={`p-3.5 rounded-xl border text-xs flex items-center justify-between transition ${
          message.type === "success"
            ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-300"
            : "bg-rose-500/10 border-rose-500/20 text-rose-300"
        }`}>
          <span>{message.text}</span>
          <button onClick={() => setMessage(null)} className="text-zinc-400 hover:text-white">✕</button>
        </div>
      )}

      {/* Deliverability Subtabs */}
      <div className="flex items-center gap-1 bg-zinc-900/80 p-1 rounded-xl border border-zinc-800 w-fit text-xs font-medium">
        <button
          onClick={() => setActiveTab("overview")}
          className={`px-4 py-2 rounded-lg transition ${
            activeTab === "overview"
              ? "bg-indigo-600 text-white shadow"
              : "text-zinc-400 hover:text-white"
          }`}
        >
          Reputation & Compliance
        </button>
        <button
          onClick={() => setActiveTab("domains")}
          className={`px-4 py-2 rounded-lg transition flex items-center gap-1.5 ${
            activeTab === "domains"
              ? "bg-indigo-600 text-white shadow"
              : "text-zinc-400 hover:text-white"
          }`}
        >
          <span>Domains & DNS</span>
          <span className="px-1.5 py-0.2 rounded-full bg-zinc-800 text-[10px] text-zinc-300">{domains.length}</span>
        </button>
        <button
          onClick={() => setActiveTab("diagnostics")}
          className={`px-4 py-2 rounded-lg transition flex items-center gap-1.5 ${
            activeTab === "diagnostics"
              ? "bg-indigo-600 text-white shadow"
              : "text-zinc-400 hover:text-white"
          }`}
        >
          <span>Failure Diagnostics</span>
          {diagnostics.length > 0 && (
            <span className="px-1.5 py-0.2 rounded-full bg-rose-500/20 text-rose-300 text-[10px]">{diagnostics.length}</span>
          )}
        </button>
        <button
          onClick={() => setActiveTab("quotas")}
          className={`px-4 py-2 rounded-lg transition flex items-center gap-1.5 ${
            activeTab === "quotas"
              ? "bg-indigo-600 text-white shadow"
              : "text-zinc-400 hover:text-white"
          }`}
        >
          <span>Provider Quotas</span>
          <span className="px-1.5 py-0.2 rounded-full bg-zinc-800 text-[10px] text-zinc-300">{quotas.length}</span>
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-[300px]">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : (
        <>
          {/* TAB 1: OVERVIEW & REPUTATION */}
          {activeTab === "overview" && reputation && (
            <div className="space-y-6">
              {/* Top Hero: Score & Compliance Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                {/* Score Gauge Card */}
                <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-6 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Sender Reputation Score</span>
                      <span className={`px-2.5 py-1 rounded-full text-xs font-bold border ${getScoreColor(reputation.score)}`}>
                        {reputation.grade}
                      </span>
                    </div>
                    <div className="mt-4 flex items-baseline gap-3">
                      <span className="text-5xl font-black tracking-tight text-white">{reputation.score}</span>
                      <span className="text-sm text-zinc-400">/ 100</span>
                    </div>
                    <p className="text-xs text-zinc-400 mt-2">
                      Computed from SPF/DKIM/DMARC alignment, spam complaints, bounce rate, and delivery volume.
                    </p>
                  </div>

                  {/* Factor Breakdown Bars */}
                  <div className="mt-6 space-y-2.5 text-xs">
                    <div>
                      <div className="flex justify-between text-zinc-300 mb-1">
                        <span>Domain Authentication</span>
                        <span>{reputation.factors.authenticationScore} / 30</span>
                      </div>
                      <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${(reputation.factors.authenticationScore / 30) * 100}%` }}></div>
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-zinc-300 mb-1">
                        <span>Spam Complaint Health</span>
                        <span>{reputation.factors.complaintScore} / 35</span>
                      </div>
                      <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${(reputation.factors.complaintScore / 35) * 100}%` }}></div>
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-zinc-300 mb-1">
                        <span>Bounce Rate Protection</span>
                        <span>{reputation.factors.bounceScore} / 25</span>
                      </div>
                      <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <div className="h-full bg-sky-500 rounded-full" style={{ width: `${(reputation.factors.bounceScore / 25) * 100}%` }}></div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Google & Yahoo Compliance Checklist Card */}
                <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-6 lg:col-span-2 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-white">Google & Yahoo 2024+ Sender Mandate</h3>
                        <p className="text-xs text-zinc-400 mt-0.5">Enforced rules for inbox placement across Gmail and Yahoo Mail.</p>
                      </div>
                      <span className={`px-3 py-1 rounded-full text-xs font-bold border ${
                        reputation.googleYahooCompliance.compliant
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                          : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                      }`}>
                        {reputation.googleYahooCompliance.compliant ? "✅ Fully Compliant" : "⚠️ Action Required"}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4 text-xs">
                      <div className="p-3 bg-zinc-950/60 rounded-xl border border-zinc-800/80 flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-white">SPF Alignment</p>
                          <p className="text-[11px] text-zinc-400">Authorized sender include directive</p>
                        </div>
                        {reputation.googleYahooCompliance.checks.spfVerified ? (
                          <span className="text-emerald-400 font-bold">✓ PASS</span>
                        ) : (
                          <span className="text-rose-400 font-bold">✗ FAIL</span>
                        )}
                      </div>

                      <div className="p-3 bg-zinc-950/60 rounded-xl border border-zinc-800/80 flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-white">DKIM Public Key</p>
                          <p className="text-[11px] text-zinc-400">Cryptographic message signing</p>
                        </div>
                        {reputation.googleYahooCompliance.checks.dkimVerified ? (
                          <span className="text-emerald-400 font-bold">✓ PASS</span>
                        ) : (
                          <span className="text-rose-400 font-bold">✗ FAIL</span>
                        )}
                      </div>

                      <div className="p-3 bg-zinc-950/60 rounded-xl border border-zinc-800/80 flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-white">DMARC Policy</p>
                          <p className="text-[11px] text-zinc-400">p=quarantine or p=reject</p>
                        </div>
                        {reputation.googleYahooCompliance.checks.dmarcVerified ? (
                          <span className="text-emerald-400 font-bold">✓ PASS</span>
                        ) : (
                          <span className="text-amber-400 font-bold">⚠️ None / Missing</span>
                        )}
                      </div>

                      <div className="p-3 bg-zinc-950/60 rounded-xl border border-zinc-800/80 flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-white">Spam Complaint Rate</p>
                          <p className="text-[11px] text-zinc-400">Strictly below 0.30% (ideally &lt;0.10%)</p>
                        </div>
                        {reputation.googleYahooCompliance.checks.complaintRateSafe ? (
                          <span className="text-emerald-400 font-bold">✓ {reputation.metrics7d.complaintRate}%</span>
                        ) : (
                          <span className="text-rose-400 font-bold">✗ {reputation.metrics7d.complaintRate}%</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {reputation.googleYahooCompliance.missingRequirements.length > 0 && (
                    <div className="mt-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
                      <p className="font-semibold">Missing Requirements:</p>
                      <ul className="list-disc list-inside mt-1 space-y-0.5 text-zinc-300 text-[11px]">
                        {reputation.googleYahooCompliance.missingRequirements.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>

              {/* 24-Hour & 7-Day Deliverability Metrics Grid */}
              <div>
                <h3 className="text-sm font-semibold text-zinc-300 mb-3">Deliverability Performance Telemetry</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3.5">
                    <p className="text-xs text-zinc-400 font-medium">7d Sent Volume</p>
                    <p className="text-xl font-bold text-white mt-1">{reputation.metrics7d.sentCount}</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">24h: {reputation.metrics24h.sentCount}</p>
                  </div>

                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3.5">
                    <p className="text-xs text-zinc-400 font-medium">Delivery Rate</p>
                    <p className="text-xl font-bold text-emerald-400 mt-1">{reputation.metrics7d.deliveryRate}%</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">Target: &gt;98.0%</p>
                  </div>

                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3.5">
                    <p className="text-xs text-zinc-400 font-medium">Bounce Rate (7d)</p>
                    <p className={`text-xl font-bold mt-1 ${reputation.metrics7d.bounceRate <= 2.0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {reputation.metrics7d.bounceRate}%
                    </p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">{reputation.metrics7d.bouncedCount} bounced</p>
                  </div>

                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3.5">
                    <p className="text-xs text-zinc-400 font-medium">Complaint Rate</p>
                    <p className={`text-xl font-bold mt-1 ${reputation.metrics7d.complaintRate <= 0.1 ? "text-emerald-400" : "text-amber-400"}`}>
                      {reputation.metrics7d.complaintRate}%
                    </p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">Google limit: 0.10%</p>
                  </div>

                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3.5">
                    <p className="text-xs text-zinc-400 font-medium">Verified Domains</p>
                    <p className="text-xl font-bold text-indigo-400 mt-1">
                      {domains.filter((d) => d.verificationStatus === "VERIFIED").length} / {domains.length}
                    </p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">Custom sending domains</p>
                  </div>

                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3.5">
                    <p className="text-xs text-zinc-400 font-medium">Active Providers</p>
                    <p className="text-xl font-bold text-white mt-1">{quotas.length}</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">Dispatches routed</p>
                  </div>
                </div>
              </div>

              {/* Actionable Alerts Section */}
              {reputation.actionableAlerts.length > 0 && (
                <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">Actionable Deliverability Recommendations</h4>
                  <div className="space-y-1.5">
                    {reputation.actionableAlerts.map((alert, idx) => (
                      <div key={idx} className="flex items-start gap-2 text-xs text-zinc-300">
                        <span className="text-amber-400 font-bold">•</span>
                        <span>{alert}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: DOMAINS & DNS VERIFICATION */}
          {activeTab === "domains" && (
            <div className="space-y-6">
              {/* Register New Domain Card */}
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
                <h3 className="text-sm font-semibold text-white">Register Sending Domain</h3>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Add a custom domain to configure SPF, DKIM, and DMARC for optimal inbox placement.
                </p>

                <form onSubmit={handleCreateDomain} className="mt-4 grid grid-cols-1 sm:grid-cols-5 gap-3">
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-medium text-zinc-400 mb-1">Domain Name</label>
                    <input
                      type="text"
                      placeholder="e.g. mail.yourcompany.com"
                      value={newDomainName}
                      onChange={(e) => setNewDomainName(e.target.value)}
                      className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-zinc-400 mb-1">Provider Architecture</label>
                    <select
                      value={newProviderType}
                      onChange={(e) => setNewProviderType(e.target.value)}
                      className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-xs text-white focus:outline-none focus:border-indigo-500"
                    >
                      <option value="GMAIL">Google Workspace / Gmail</option>
                      <option value="SES">Amazon SES</option>
                      <option value="SMTP">Custom SMTP Relay</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-zinc-400 mb-1">DKIM Selector</label>
                    <input
                      type="text"
                      placeholder="whub"
                      value={newSelector}
                      onChange={(e) => setNewSelector(e.target.value)}
                      className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div className="flex items-end">
                    <button
                      type="submit"
                      disabled={creatingDomain || !newDomainName}
                      className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1.5"
                    >
                      {creatingDomain ? (
                        <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      ) : (
                        <span>+ Add & Generate DNS</span>
                      )}
                    </button>
                  </div>
                </form>
              </div>

              {/* Registered Domains Table */}
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-white">Configured Domains ({domains.length})</h3>
                  <span className="text-xs text-zinc-400">Actual DNS resolution enforced</span>
                </div>

                {domains.length === 0 ? (
                  <div className="p-8 text-center text-xs text-zinc-500">
                    No custom sending domains registered yet. Register your domain above to configure DNS authentication.
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-800/80">
                    {domains.map((domain) => (
                      <div key={domain.id} className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2.5">
                            <span className="text-sm font-bold text-white">{domain.domain}</span>
                            {domain.verificationStatus === "VERIFIED" ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                ✓ DOMAIN VERIFIED
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                ⏳ VERIFICATION PENDING
                              </span>
                            )}
                          </div>

                          {/* DNS Status Pills */}
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <div className="flex items-center gap-1 bg-zinc-950 px-2 py-1 rounded border border-zinc-800">
                              <span className="text-zinc-400 font-mono text-[10px]">SPF:</span>
                              {getDnsBadge(domain.spfStatus)}
                            </div>
                            <div className="flex items-center gap-1 bg-zinc-950 px-2 py-1 rounded border border-zinc-800">
                              <span className="text-zinc-400 font-mono text-[10px]">DKIM ({domain.dkimSelector}):</span>
                              {getDnsBadge(domain.dkimStatus)}
                            </div>
                            <div className="flex items-center gap-1 bg-zinc-950 px-2 py-1 rounded border border-zinc-800">
                              <span className="text-zinc-400 font-mono text-[10px]">DMARC:</span>
                              {getDnsBadge(domain.dmarcStatus)}
                              {domain.dmarcPolicy && (
                                <span className="text-[10px] text-zinc-400 font-mono">({domain.dmarcPolicy})</span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 bg-zinc-950 px-2 py-1 rounded border border-zinc-800">
                              <span className="text-zinc-400 font-mono text-[10px]">MX:</span>
                              {getDnsBadge(domain.mxStatus)}
                            </div>
                          </div>

                          {domain.lastCheckedAt && (
                            <p className="text-[10px] text-zinc-500">
                              Last checked: {new Date(domain.lastCheckedAt).toLocaleString()}
                            </p>
                          )}
                        </div>

                        {/* Action Buttons */}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleViewGuidance(domain)}
                            className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium border border-zinc-700 transition"
                          >
                            DNS Records
                          </button>
                          <button
                            onClick={() => handleVerifyDomain(domain.id)}
                            disabled={verifyingDomainId === domain.id}
                            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition flex items-center gap-1"
                          >
                            {verifyingDomainId === domain.id ? (
                              <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                            ) : (
                              <span>Check DNS Now</span>
                            )}
                          </button>
                          <button
                            onClick={() => handleDeleteDomain(domain.id, domain.domain)}
                            className="px-2.5 py-1.5 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg text-xs transition"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* DNS Guidance Modal / Drawer */}
              {selectedDomainGuidance && (
                <div className="bg-zinc-900 border border-indigo-500/30 rounded-2xl p-6 shadow-2xl space-y-4">
                  <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                    <div>
                      <h3 className="text-sm font-bold text-white flex items-center gap-2">
                        <span>DNS Authentication Instructions for</span>
                        <span className="text-indigo-400 font-mono">{selectedDomainGuidance.domain.domain}</span>
                      </h3>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        Add the following TXT and MX records at your domain registrar (GoDaddy, Cloudflare, Route53, Namecheap).
                      </p>
                    </div>
                    <button
                      onClick={() => setSelectedDomainGuidance(null)}
                      className="text-zinc-400 hover:text-white text-sm"
                    >
                      ✕ Close
                    </button>
                  </div>

                  <div className="space-y-3">
                    {selectedDomainGuidance.records.map((rec, idx) => (
                      <div key={idx} className="p-3.5 bg-zinc-950 rounded-xl border border-zinc-800 space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 rounded font-mono font-bold text-[10px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                              {rec.type}
                            </span>
                            <span className="font-semibold text-white">{rec.purpose}</span>
                            <span className="text-[11px] text-zinc-400">({rec.description})</span>
                          </div>
                          {rec.recommended && (
                            <span className="text-[10px] text-emerald-400 font-medium">Recommended</span>
                          )}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                          <div className="p-2 bg-zinc-900 rounded border border-zinc-800 flex items-center justify-between">
                            <div className="overflow-hidden">
                              <span className="text-[10px] text-zinc-500 block">Host / Name</span>
                              <span className="font-mono text-zinc-200 text-xs truncate block">{rec.host}</span>
                            </div>
                            <button
                              onClick={() => copyToClipboard(rec.host, `${idx}-host`)}
                              className="text-[10px] text-indigo-400 hover:text-indigo-300 ml-2"
                            >
                              {copiedField === `${idx}-host` ? "✓ Copied" : "Copy"}
                            </button>
                          </div>

                          <div className="sm:col-span-2 p-2 bg-zinc-900 rounded border border-zinc-800 flex items-center justify-between">
                            <div className="overflow-hidden">
                              <span className="text-[10px] text-zinc-500 block">Value / Content</span>
                              <span className="font-mono text-zinc-200 text-xs truncate block">{rec.value}</span>
                            </div>
                            <button
                              onClick={() => copyToClipboard(rec.value, `${idx}-val`)}
                              className="text-[10px] text-indigo-400 hover:text-indigo-300 ml-2 shrink-0"
                            >
                              {copiedField === `${idx}-val` ? "✓ Copied" : "Copy Value"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-end pt-2">
                    <button
                      onClick={() => handleVerifyDomain(selectedDomainGuidance.domain.id)}
                      disabled={verifyingDomainId === selectedDomainGuidance.domain.id}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold transition"
                    >
                      {verifyingDomainId === selectedDomainGuidance.domain.id ? "Checking DNS..." : "Verify DNS Records Now"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: DELIVERY FAILURE DIAGNOSTICS */}
          {activeTab === "diagnostics" && (
            <div className="space-y-6">
              {/* Category Filter Pills */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-zinc-400 text-[11px] font-medium mr-1">Filter by category:</span>
                {[
                  { key: "ALL", label: "All Failures" },
                  { key: "AUTHENTICATION_FAILED", label: "Auth Failed" },
                  { key: "SPAM_BLOCK", label: "Spam Block" },
                  { key: "INVALID_RECIPIENT", label: "Invalid Recipient" },
                  { key: "MAILBOX_FULL", label: "Mailbox Full" },
                  { key: "DNS_LOOKUP_FAILURE", label: "DNS Failure" },
                  { key: "RATE_LIMITED", label: "Rate Limited" },
                ].map((cat) => (
                  <button
                    key={cat.key}
                    onClick={() => setSelectedCategoryFilter(cat.key)}
                    className={`px-3 py-1 rounded-lg transition ${
                      selectedCategoryFilter === cat.key
                        ? "bg-indigo-600 text-white font-semibold"
                        : "bg-zinc-900 text-zinc-400 hover:text-white border border-zinc-800"
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

              {/* Diagnostics Stream */}
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-white">Delivery Failure Stream ({filteredDiagnostics.length})</h3>
                  <span className="text-xs text-zinc-400">Classified with actionable remediation</span>
                </div>

                {filteredDiagnostics.length === 0 ? (
                  <div className="p-8 text-center text-xs text-zinc-500">
                    No delivery failures recorded for this category.
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-800/80">
                    {filteredDiagnostics.map((item) => (
                      <div key={item.id} className="p-4 space-y-2">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            {getFailureCategoryBadge(item.failureCategory)}
                            {item.smtpCode && (
                              <span className="px-2 py-0.5 rounded font-mono text-[10px] bg-zinc-800 text-zinc-300">
                                {item.smtpCode}
                              </span>
                            )}
                            <span className="text-xs font-semibold text-white">{item.recipient}</span>
                          </div>
                          <span className="text-[10px] text-zinc-500">
                            {new Date(item.failedAt).toLocaleString()}
                          </span>
                        </div>

                        <p className="text-xs text-zinc-300">
                          <span className="font-semibold text-zinc-200">Issue: </span>
                          {item.humanSummary}
                        </p>

                        <div className="p-2.5 rounded-lg bg-zinc-950/80 border border-zinc-800/80 text-[11px] text-indigo-300 flex items-start gap-2">
                          <span className="text-indigo-400 font-bold shrink-0">💡 Remediation:</span>
                          <span>{item.recommendedRemediation}</span>
                        </div>

                        {item.campaignName && (
                          <p className="text-[10px] text-zinc-500">
                            Campaign: <span className="text-zinc-400">{item.campaignName}</span> • Subject: &quot;{item.subject}&quot;
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 4: PROVIDER QUOTA MONITORING */}
          {activeTab === "quotas" && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {quotas.map((quota) => (
                  <div key={quota.providerConfigId} className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-bold text-white">{quota.providerName}</h3>
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-zinc-800 text-zinc-300">
                            {quota.providerType}
                          </span>
                        </div>
                        {quota.senderEmail && (
                          <p className="text-xs text-zinc-400 mt-0.5">{quota.senderEmail}</p>
                        )}
                      </div>
                      <span className={`px-2.5 py-1 rounded-full text-xs font-bold border ${
                        quota.status === "NORMAL"
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                          : quota.status === "WARNING"
                          ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
                          : quota.status === "CRITICAL"
                          ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                          : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                      }`}>
                        {quota.status}
                      </span>
                    </div>

                    {/* Progress Bar */}
                    <div>
                      <div className="flex justify-between text-xs text-zinc-300 mb-1.5 font-medium">
                        <span>Daily Quota Consumption</span>
                        <span>{quota.sentToday} / {quota.dailyLimit} ({quota.percentUsed}%)</span>
                      </div>
                      <div className="w-full h-2.5 bg-zinc-950 rounded-full overflow-hidden border border-zinc-800">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            quota.percentUsed >= 95
                              ? "bg-rose-500"
                              : quota.percentUsed >= 80
                              ? "bg-amber-500"
                              : "bg-indigo-500"
                          }`}
                          style={{ width: `${Math.min(100, quota.percentUsed)}%` }}
                        ></div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-center text-xs pt-2 border-t border-zinc-800/80">
                      <div className="p-2 bg-zinc-950 rounded-lg">
                        <p className="text-[10px] text-zinc-500">Remaining</p>
                        <p className="text-sm font-bold text-white mt-0.5">{quota.remaining}</p>
                      </div>
                      <div className="p-2 bg-zinc-950 rounded-lg">
                        <p className="text-[10px] text-zinc-500">Hourly Rate</p>
                        <p className="text-sm font-bold text-sky-400 mt-0.5">{quota.hourlyRate}/hr</p>
                      </div>
                      <div className="p-2 bg-zinc-950 rounded-lg">
                        <p className="text-[10px] text-zinc-500">Reset Schedule</p>
                        <p className="text-[11px] font-semibold text-zinc-300 mt-0.5">00:00 UTC</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
