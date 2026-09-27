"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

interface ProviderConfig {
  id: string;
  name: string;
  providerType: string;
  status: string;
  isDefault: boolean;
  senderEmail: string | null;
  senderName: string | null;
  lastVerifiedAt: string | null;
  errorMessage?: string | null;
  createdAt: string;
}

interface SenderIdentity {
  id: string;
  email: string;
  name: string | null;
  replyToEmail: string | null;
  isDefault: boolean;
  verified: boolean;
  verifiedAt: string | null;
  createdAt: string;
}

interface BannerNotice {
  type: "success" | "error";
  title: string;
  message: string;
}

function ProviderSettingsContent() {
  const searchParams = useSearchParams();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [senderIdentities, setSenderIdentities] = useState<SenderIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [banner, setBanner] = useState<BannerNotice | null>(null);

  // Add Sender Identity modal state
  const [showAddSenderModal, setShowAddSenderModal] = useState(false);
  const [senderEmail, setSenderEmail] = useState("");
  const [senderName, setSenderName] = useState("");
  const [replyToEmail, setReplyToEmail] = useState("");
  const [isDefaultSender, setIsDefaultSender] = useState(false);
  const [isVerifiedSender, setIsVerifiedSender] = useState(true);
  const [addingSender, setAddingSender] = useState(false);
  const [senderError, setSenderError] = useState<string | null>(null);

  async function loadData() {
    try {
      const [provRes, sndRes] = await Promise.all([
        fetch("/api/admin/email/providers"),
        fetch("/api/admin/email/sender-identities"),
      ]);

      if (provRes.ok) {
        const json = await provRes.json();
        setProviders(json.data || []);
      }

      if (sndRes.ok) {
        const json = await sndRes.json();
        setSenderIdentities(json.data || []);
      }
    } catch {
      // Safe fallback
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();

    // Check for callback query parameters from Google OAuth redirect
    const status = searchParams.get("status");
    const providerParam = searchParams.get("provider");
    const messageParam = searchParams.get("message");

    if (status === "success") {
      setBanner({
        type: "success",
        title: "Google Workspace Connected",
        message: providerParam
          ? `Successfully authenticated and configured sender identity for ${providerParam}.`
          : "Successfully authenticated and configured Google Workspace provider.",
      });
      loadData();
    } else if (status === "error") {
      setBanner({
        type: "error",
        title: "OAuth Connection Failed",
        message: messageParam || "Failed to complete Google Workspace authorization. Please try again.",
      });
    }
  }, [searchParams]);

  function handleDismissBanner() {
    setBanner(null);
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", "/dashboard/email/providers");
    }
  }

  async function handleConnectGmail() {
    try {
      setConnecting(true);
      const res = await fetch("/api/admin/email/providers/google/oauth", {
        headers: { Accept: "application/json" },
      });
      const json = await res.json();

      if (res.ok && json.data?.authUrl) {
        window.location.href = json.data.authUrl;
      } else {
        setBanner({
          type: "error",
          title: "Connection Failed",
          message: json.error || "Unable to initiate Google OAuth. Check your GMAIL_CLIENT_ID configuration.",
        });
        setConnecting(false);
      }
    } catch {
      setBanner({
        type: "error",
        title: "Network Error",
        message: "Failed to connect to the authorization server.",
      });
      setConnecting(false);
    }
  }

  async function handleSetDefaultProvider(providerId: string) {
    try {
      const res = await fetch("/api/admin/email/providers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: providerId, isDefault: true }),
      });

      const json = await res.json();
      if (!res.ok) {
        alert(json.error || "Failed to set default provider");
        return;
      }
      loadData();
    } catch {
      // Safe fallback
    }
  }

  async function handleAddSenderIdentity(e: React.FormEvent) {
    e.preventDefault();
    setAddingSender(true);
    setSenderError(null);

    try {
      const res = await fetch("/api/admin/email/sender-identities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: senderEmail.trim(),
          name: senderName.trim() || undefined,
          replyToEmail: replyToEmail.trim() || undefined,
          isDefault: isDefaultSender,
          verified: isVerifiedSender,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Failed to create sender identity");
      }

      setShowAddSenderModal(false);
      setSenderEmail("");
      setSenderName("");
      setReplyToEmail("");
      setIsDefaultSender(false);
      loadData();
    } catch (err) {
      setSenderError(err instanceof Error ? err.message : "Error creating sender identity");
    } finally {
      setAddingSender(false);
    }
  }

  async function handleSetDefaultSender(identity: SenderIdentity) {
    try {
      const res = await fetch("/api/admin/email/sender-identities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: identity.email,
          name: identity.name || undefined,
          replyToEmail: identity.replyToEmail || undefined,
          verified: identity.verified,
          isDefault: true,
        }),
      });

      if (res.ok) {
        loadData();
      }
    } catch {
      // Safe fallback
    }
  }

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Email Providers & Sender Identities</h1>
          <p className="text-sm text-zinc-400">
            Configure Google Workspace OAuth connections and manage verified sender identities used by campaign workers.
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
              setSenderError(null);
              setShowAddSenderModal(true);
            }}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
          >
            + Add Sender Identity
          </button>
        </div>
      </div>

      {/* OAuth Callback Notification Banner */}
      {banner && (
        <div
          className={`p-4 rounded-xl border flex items-start justify-between gap-3 ${
            banner.type === "success"
              ? "bg-emerald-950/40 border-emerald-800/80 text-emerald-200"
              : "bg-rose-950/40 border-rose-800/80 text-rose-200"
          }`}
        >
          <div className="flex items-start gap-3">
            <span className="text-xl shrink-0">{banner.type === "success" ? "✅" : "⚠️"}</span>
            <div>
              <h4 className="font-semibold text-sm">{banner.title}</h4>
              <p className="text-xs opacity-90 mt-0.5">{banner.message}</p>
            </div>
          </div>
          <button
            onClick={handleDismissBanner}
            className="text-xs opacity-60 hover:opacity-100 transition px-2 py-1 rounded"
            aria-label="Dismiss notice"
          >
            ✕
          </button>
        </div>
      )}

      {/* Google Workspace OAuth Card */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl">📧</span>
            <h2 className="text-base font-bold text-white">Google Workspace / Gmail Integration</h2>
          </div>
          <p className="text-xs text-zinc-400 mt-1 max-w-xl">
            Authorizes transactional and campaign dispatch via Google Workspace API with the narrowest scope (<code className="text-zinc-300">gmail.send</code>).
            Tokens are encrypted at rest with AES-256-GCM.
          </p>
        </div>
        <button
          onClick={handleConnectGmail}
          disabled={connecting}
          className="px-4 py-2.5 bg-white hover:bg-zinc-100 disabled:opacity-50 text-zinc-950 font-medium rounded-lg text-sm transition flex items-center justify-center gap-2 shrink-0 shadow-sm"
        >
          {connecting ? (
            <>
              <div className="w-4 h-4 border-2 border-zinc-950 border-t-transparent rounded-full animate-spin"></div>
              <span>Connecting...</span>
            </>
          ) : (
            <>
              <span>Connect Google Workspace</span> &rarr;
            </>
          )}
        </button>
      </div>

      {/* Configured Providers Table */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
          Configured Email Providers
        </h3>

        {loading ? (
          <div className="flex items-center justify-center min-h-[150px]">
            <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : providers.length === 0 ? (
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-8 text-center text-zinc-400 text-xs">
            No external email providers connected yet. Connect Google Workspace to start dispatching.
          </div>
        ) : (
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-zinc-300">
                <thead className="bg-zinc-800/40 text-xs uppercase text-zinc-400 border-b border-zinc-800">
                  <tr>
                    <th className="px-5 py-3">Provider Name</th>
                    <th className="px-5 py-3">Type</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">Connected Sender</th>
                    <th className="px-5 py-3">Default</th>
                    <th className="px-5 py-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {providers.map((p) => (
                    <tr key={p.id} className="hover:bg-zinc-800/20 transition">
                      <td className="px-5 py-3.5 font-medium text-white">{p.name}</td>
                      <td className="px-5 py-3.5 text-xs text-zinc-400">{p.providerType}</td>
                      <td className="px-5 py-3.5">
                        <span
                          className={`text-xs px-2 py-0.5 rounded font-medium border ${
                            p.status === "ACTIVE"
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                              : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                          }`}
                        >
                          {p.status}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 font-mono text-xs text-zinc-300">
                        {p.senderEmail || "N/A"}
                      </td>
                      <td className="px-5 py-3.5 text-xs">
                        {p.isDefault ? (
                          <span className="text-emerald-400 font-semibold">✓ Default</span>
                        ) : (
                          <span className="text-zinc-500">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-xs">
                        {!p.isDefault && (
                          <button
                            onClick={() => handleSetDefaultProvider(p.id)}
                            className="text-sky-400 hover:text-sky-300 font-medium transition"
                          >
                            Set Default
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Verified Sender Identities Table */}
      <div className="space-y-3 pt-4 border-t border-zinc-800">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
              Sender Identities
            </h3>
            <p className="text-xs text-zinc-500">
              Verified From addresses that campaign workers bind to during dispatch.
            </p>
          </div>
        </div>

        {senderIdentities.length === 0 ? (
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-8 text-center text-zinc-400 text-xs">
            No sender identities registered. Workers will fallback to the connected default provider address.
          </div>
        ) : (
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-zinc-300">
                <thead className="bg-zinc-800/40 text-xs uppercase text-zinc-400 border-b border-zinc-800">
                  <tr>
                    <th className="px-5 py-3">From Address</th>
                    <th className="px-5 py-3">Display Name</th>
                    <th className="px-5 py-3">Reply-To</th>
                    <th className="px-5 py-3">Verification</th>
                    <th className="px-5 py-3">Default</th>
                    <th className="px-5 py-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {senderIdentities.map((s) => (
                    <tr key={s.id} className="hover:bg-zinc-800/20 transition">
                      <td className="px-5 py-3.5 font-medium text-white font-mono text-xs">{s.email}</td>
                      <td className="px-5 py-3.5 text-zinc-300">{s.name || "—"}</td>
                      <td className="px-5 py-3.5 text-xs text-zinc-400 font-mono">{s.replyToEmail || "—"}</td>
                      <td className="px-5 py-3.5">
                        {s.verified ? (
                          <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                            ✓ Verified
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                            Unverified
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-xs">
                        {s.isDefault ? (
                          <span className="text-emerald-400 font-semibold">✓ Default</span>
                        ) : (
                          <span className="text-zinc-500">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-xs">
                        {!s.isDefault && (
                          <button
                            onClick={() => handleSetDefaultSender(s)}
                            className="text-sky-400 hover:text-sky-300 font-medium transition"
                          >
                            Set Default
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Add Sender Identity Modal */}
      {showAddSenderModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-md w-full p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Add Sender Identity</h2>

            {senderError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs">
                {senderError}
              </div>
            )}

            <form onSubmit={handleAddSenderIdentity} className="space-y-3">
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Sender Email Address</label>
                <input
                  type="email"
                  required
                  placeholder="marketing@example.com"
                  value={senderEmail}
                  onChange={(e) => setSenderEmail(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="text-xs text-zinc-400 block mb-1">Display Name (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Acme Promotions"
                  value={senderName}
                  onChange={(e) => setSenderName(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="text-xs text-zinc-400 block mb-1">Reply-To Address (Optional)</label>
                <input
                  type="email"
                  placeholder="support@example.com"
                  value={replyToEmail}
                  onChange={(e) => setReplyToEmail(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>

              <div className="pt-2 border-t border-zinc-800 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={isVerifiedSender}
                    onChange={(e) => setIsVerifiedSender(e.target.checked)}
                    className="rounded bg-zinc-950 border-zinc-700 text-sky-500 focus:ring-0"
                  />
                  <span>Mark as verified identity (authorized sender)</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={isDefaultSender}
                    onChange={(e) => setIsDefaultSender(e.target.checked)}
                    className="rounded bg-zinc-950 border-zinc-700 text-sky-500 focus:ring-0"
                  />
                  <span>Set as tenant default sender identity</span>
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setShowAddSenderModal(false)}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addingSender}
                  className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  {addingSender ? "Saving..." : "Save Identity"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ProviderSettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-[300px]">
          <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      }
    >
      <ProviderSettingsContent />
    </Suspense>
  );
}
