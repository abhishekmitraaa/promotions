"use client";

import { useEffect, useState } from "react";

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

export default function ProviderSettingsPage() {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);

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
  }, []);

  function handleConnectGmail() {
    // Redirect to Google OAuth authorization endpoint
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/api/admin/email/providers/google/oauth";
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Email Provider Configuration</h1>
        <p className="text-sm text-zinc-400">
          Connect and configure Google Workspace / Gmail OAuth providers. Credentials and tokens are securely encrypted at rest and never exposed.
        </p>
      </div>

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
          className="px-4 py-2.5 bg-white hover:bg-zinc-100 text-zinc-950 font-medium rounded-lg text-sm transition flex items-center justify-center gap-2 shrink-0 shadow-sm"
        >
          <span>Connect Google Workspace</span> &rarr;
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
