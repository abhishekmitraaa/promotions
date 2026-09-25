"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

interface ProviderConfig {
  id: string;
  name: string;
  providerType: string;
  status: string;
  isDefault: boolean;
  senderEmail: string | null;
  senderName: string | null;
  lastVerifiedAt: string | null;
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
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [banner, setBanner] = useState<BannerNotice | null>(null);

  async function loadProviders() {
    try {
      const res = await fetch("/api/admin/email/providers");
      if (res.ok) {
        const json = await res.json();
        setProviders(json.data || []);
      }
    } catch {
      // Safe fallback
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProviders();

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
      // Re-fetch to immediately display newly connected provider in table
      loadProviders();
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
        // Redirect browser to Google's consent screen
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Email Provider Configuration</h1>
        <p className="text-sm text-zinc-400">
          Connect and configure Google Workspace / Gmail OAuth providers. Credentials and tokens are securely encrypted at rest and never exposed.
        </p>
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

      {/* Gmail OAuth Connect Card */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl">📧</span>
            <h2 className="text-base font-bold text-white">Google Workspace / Gmail Integration</h2>
          </div>
          <p className="text-xs text-zinc-400 mt-1 max-w-xl">
            Authorizes transactional and campaign dispatch via Google Workspace API with the narrowest scope (<code className="text-zinc-300">gmail.send</code>).
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

      {/* Active Providers Table */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
          Configured Providers
        </h3>

        {loading ? (
          <div className="flex items-center justify-center min-h-[200px]">
            <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : providers.length === 0 ? (
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-8 text-center text-zinc-400">
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
                    <th className="px-5 py-3">Sender Identity</th>
                    <th className="px-5 py-3">Default</th>
                    <th className="px-5 py-3">Connected Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {providers.map((p) => (
                    <tr key={p.id} className="hover:bg-zinc-800/20 transition">
                      <td className="px-5 py-3.5 font-medium text-white">{p.name}</td>
                      <td className="px-5 py-3.5 text-xs text-zinc-400">{p.providerType}</td>
                      <td className="px-5 py-3.5">
                        <span className="text-xs px-2 py-0.5 rounded font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          {p.status}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 font-mono text-xs text-zinc-300">
                        {p.senderEmail || "N/A"}
                      </td>
                      <td className="px-5 py-3.5 text-xs">
                        {p.isDefault ? (
                          <span className="text-emerald-400 font-medium">Default</span>
                        ) : (
                          <span className="text-zinc-500">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-xs text-zinc-500">
                        {new Date(p.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
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
