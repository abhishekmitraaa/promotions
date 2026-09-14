"use client";

import { useEffect, useState } from "react";

interface ApiKeyItem {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
}

interface ApiClientItem {
  id: string;
  name: string;
  description?: string | null;
  keys: ApiKeyItem[];
  createdAt: string;
}

export default function DashboardApiKeysPage() {
  const [clients, setClients] = useState<ApiClientItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [clientName, setClientName] = useState("");
  const [keyName, setKeyName] = useState("Primary Key");
  const [creating, setCreating] = useState(false);

  // One-time Raw Key Display Modal State
  const [generatedRawKey, setGeneratedRawKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchApiClients();
  }, []);

  async function fetchApiClients() {
    try {
      setLoading(true);
      const res = await fetch("/api/admin/api-keys");
      const json = await res.json();
      if (json.success) {
        setClients(json.data || json.clients || []);
      }
    } catch (err) {
      console.error("Failed to load API keys:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);

    try {
      const res = await fetch("/api/admin/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientName, keyName }),
      });

      const json = await res.json();

      if (json.success && json.data.rawKey) {
        setGeneratedRawKey(json.data.rawKey);
        setShowCreateModal(false);
        setClientName("");
        fetchApiClients();
      } else {
        alert(json.error || "Failed to generate API key");
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error generating API key");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevokeKey(keyId: string) {
    if (!confirm("Are you sure you want to revoke this API key? Applications using it will lose access immediately.")) {
      return;
    }

    try {
      const res = await fetch(`/api/admin/api-keys/${keyId}/revoke`, {
        method: "POST",
      });
      const json = await res.json();
      if (json.success) {
        fetchApiClients();
      } else {
        alert(json.error || "Failed to revoke API key");
      }
    } catch {
      alert("Error revoking API key");
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">API Keys & Clients</h2>
          <p className="text-zinc-400 text-sm">
            Manage Bearer API keys used by external applications to authenticate requests.
          </p>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold rounded-xl text-sm transition shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
        >
          <span>🔑</span> Generate New API Key
        </button>
      </div>

      {/* Security Note */}
      <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 text-xs text-zinc-400 flex items-start gap-3">
        <span className="text-base">🛡️</span>
        <div>
          <span className="font-semibold text-zinc-200">Security Architecture:</span> Raw API keys are never stored in the database. Only an HMAC-SHA256 hash using your configured pepper is persisted. The raw key is shown only once upon creation.
        </div>
      </div>

      {/* Clients & Keys List */}
      <div className="space-y-6">
        {loading ? (
          <div className="text-center py-12 text-zinc-500">Loading API keys...</div>
        ) : clients.length === 0 ? (
          <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-8 text-center text-zinc-500 text-sm">
            No API clients or keys created yet. Click <span className="text-emerald-400 font-semibold">&quot;Generate New API Key&quot;</span> above or run <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-300 font-mono">npm run create:api-key</code> in CLI.
          </div>
        ) : (
          clients.map((client) => (
            <div key={client.id} className="bg-zinc-900/40 border border-zinc-800 rounded-2xl overflow-hidden">
              <div className="p-4 bg-zinc-900/80 border-b border-zinc-800 flex justify-between items-center">
                <div>
                  <h3 className="font-bold text-white text-base">{client.name}</h3>
                  <p className="text-xs text-zinc-500">Client ID: {client.id}</p>
                </div>
                <span className="text-xs px-2.5 py-1 rounded-full bg-zinc-800 text-zinc-300 font-mono">
                  {client.keys.length} Keys
                </span>
              </div>

              <div className="divide-y divide-zinc-800/60">
                {client.keys.map((key) => (
                  <div key={key.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-zinc-800/20 transition">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-zinc-200">{key.name}</span>
                        <code className="text-xs bg-zinc-800 px-2 py-0.5 rounded text-emerald-400 font-mono">
                          {key.keyPrefix}...
                        </code>
                        {key.revokedAt ? (
                          <span className="text-[10px] px-2 py-0.5 rounded bg-rose-950 text-rose-400 border border-rose-800 font-semibold">
                            REVOKED
                          </span>
                        ) : (
                          <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-semibold">
                            ACTIVE
                          </span>
                        )}
                      </div>

                      <div className="text-xs text-zinc-500 mt-1 flex items-center gap-4">
                        <span>Created: {new Date(key.createdAt).toLocaleDateString()}</span>
                        <span>
                          Last Used: {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "Never"}
                        </span>
                      </div>
                    </div>

                    {!key.revokedAt && (
                      <button
                        onClick={() => handleRevokeKey(key.id)}
                        className="px-3 py-1.5 bg-rose-950/60 hover:bg-rose-900 border border-rose-800 text-rose-300 text-xs font-medium rounded-lg transition"
                      >
                        Revoke Key
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-4 shadow-2xl">
            <h3 className="text-lg font-bold text-white">Generate API Key</h3>

            <form onSubmit={handleCreateKey} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-400 uppercase mb-1">
                  Client / Application Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. CRM Service App"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 uppercase mb-1">
                  Key Identifier Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Production Key"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-sm transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold rounded-xl text-sm transition shadow-lg shadow-emerald-500/20"
                >
                  {creating ? "Generating..." : "Generate Key"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Raw Key Display Modal */}
      {generatedRawKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-lg bg-zinc-900 border border-emerald-500/50 rounded-2xl p-6 space-y-5 shadow-2xl">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🎉</span>
              <div>
                <h3 className="text-lg font-bold text-white">API Key Generated Successfully</h3>
                <p className="text-xs text-amber-400 font-medium">
                  Copy this key now! It will never be displayed again.
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2">
              <div className="text-xs text-zinc-400 font-mono">Raw Bearer API Key:</div>
              <div className="font-mono text-sm text-emerald-400 break-all select-all">
                {generatedRawKey}
              </div>
            </div>

            <div className="flex justify-between items-center pt-2">
              <button
                onClick={() => copyToClipboard(generatedRawKey)}
                className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-xl text-sm transition shadow-lg shadow-emerald-500/20 flex items-center gap-2"
              >
                <span>{copied ? "✅ Copied!" : "📋 Copy API Key"}</span>
              </button>

              <button
                onClick={() => setGeneratedRawKey(null)}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-sm transition"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
