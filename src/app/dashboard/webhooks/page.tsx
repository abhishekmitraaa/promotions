"use client";

import { useEffect, useState } from "react";

interface WebhookEndpointItem {
  id: string;
  name: string;
  url: string;
  active: boolean;
  subscribedEvents: string;
  createdAt: string;
  _count?: { deliveries: number };
}

interface WebhookDeliveryItem {
  id: string;
  endpointId: string;
  eventType: string;
  status: string;
  attemptCount: number;
  responseStatus?: number | null;
  errorMessage?: string | null;
  createdAt: string;
  endpoint?: { name: string; url: string };
}

export default function DashboardWebhooksPage() {
  const [endpoints, setEndpoints] = useState<WebhookEndpointItem[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Add Endpoint Modal State
  const [showAddModal, setShowAddModal] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["*"]);
  const [adding, setAdding] = useState(false);

  // One-time Revealed Signing Secret Modal State
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  async function fetchWebhookData() {
    try {
      const [epRes, delRes] = await Promise.all([
        fetch("/api/admin/webhooks"),
        fetch("/api/admin/webhooks/deliveries"),
      ]);

      const epJson = await epRes.json();
      const delJson = await delRes.json();

      if (epJson.success) setEndpoints(epJson.data || epJson.endpoints || []);
      if (delJson.success) setDeliveries(delJson.data || delJson.deliveries || []);
    } catch (err) {
      console.error("Failed to load webhooks:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchWebhookData();
  }, []);

  async function handleAddEndpoint(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);

    try {
      const res = await fetch("/api/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, url, subscribedEvents: events }),
      });

      const json = await res.json();
      if (json.success) {
        setShowAddModal(false);
        setName("");
        setUrl("");
        fetchWebhookData();
        if (json.data?.signingSecret) {
          setRevealedSecret(json.data.signingSecret);
        }
      } else {
        alert(json.error || "Failed to add webhook endpoint");
      }
    } catch {
      alert("Error adding webhook endpoint");
    } finally {
      setAdding(false);
    }
  }

  async function handleRegenerateSecret(endpointId: string) {
    if (
      !confirm(
        "Regenerating this signing secret will immediately invalidate the existing secret for this endpoint. Any receiver verifying requests with the old secret will fail until updated. Continue?"
      )
    ) {
      return;
    }

    try {
      const res = await fetch(`/api/admin/webhooks/${endpointId}/regenerate-secret`, {
        method: "POST",
      });
      const json = await res.json();
      if (json.success && json.data?.signingSecret) {
        setRevealedSecret(json.data.signingSecret);
      } else {
        alert(json.error || "Failed to regenerate signing secret");
      }
    } catch {
      alert("Error regenerating signing secret");
    }
  }

  async function handleRetryDelivery(deliveryId: string) {
    try {
      const res = await fetch("/api/admin/webhooks/deliveries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryId }),
      });
      const json = await res.json();
      if (json.success) {
        alert("Delivery retry triggered!");
        setTimeout(fetchWebhookData, 1000);
      }
    } catch {
      alert("Failed to trigger retry");
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Outgoing Webhooks</h2>
          <p className="text-zinc-400 text-sm">
            Forward real-time message and status events to external HTTP endpoints.
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold rounded-xl text-sm transition shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
        >
          <span>➕</span> Add Webhook Endpoint
        </button>
      </div>

      {/* Endpoints List */}
      <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl overflow-hidden">
        <div className="p-4 bg-zinc-900/80 border-b border-zinc-800 flex justify-between items-center">
          <h3 className="font-bold text-white">Registered Endpoints</h3>
          <span className="text-xs text-zinc-400">{endpoints.length} Active Target(s)</span>
        </div>

        <div className="divide-y divide-zinc-800/60">
          {loading ? (
            <div className="p-8 text-center text-zinc-500 text-sm">Loading webhooks...</div>
          ) : endpoints.length === 0 ? (
            <div className="p-8 text-center text-zinc-500 text-sm">
              No outgoing webhook endpoints registered yet. Click &quot;Add Webhook Endpoint&quot; to receive real-time events.
            </div>
          ) : (
            endpoints.map((ep) => (
              <div key={ep.id} className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-zinc-800/20 transition">
                <div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold text-white">{ep.name}</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-mono">
                      Active
                    </span>
                  </div>
                  <div className="text-xs font-mono text-emerald-400 mt-1">{ep.url}</div>
                  <div className="text-xs text-zinc-500 mt-1">
                    Subscribed: <code className="text-zinc-300 font-mono">{ep.subscribedEvents}</code>
                  </div>
                  <div className="text-xs text-zinc-400 mt-1.5 flex items-center gap-2">
                    <span className="font-medium">Signing Secret:</span>
                    <code className="text-zinc-500 font-mono text-xs">••••••••••••••••</code>
                    <button
                      onClick={() => handleRegenerateSecret(ep.id)}
                      className="text-[11px] text-amber-400 hover:text-amber-300 hover:underline flex items-center gap-1 font-medium ml-1"
                      title="Regenerate signing secret"
                    >
                      🔄 Regenerate Secret
                    </button>
                  </div>
                </div>

                <div className="text-right text-xs text-zinc-400 font-mono">
                  {ep._count?.deliveries ?? 0} deliveries dispatched
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Delivery History Audit Table */}
      <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl overflow-hidden">
        <div className="p-4 bg-zinc-900/80 border-b border-zinc-800 flex justify-between items-center">
          <h3 className="font-bold text-white">Recent Delivery History Log</h3>
          <button onClick={fetchWebhookData} className="text-xs text-emerald-400 hover:underline">
            Refresh Log
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-zinc-300">
            <thead className="bg-zinc-900/80 text-xs uppercase text-zinc-400 font-semibold border-b border-zinc-800">
              <tr>
                <th className="px-5 py-3">Event Type</th>
                <th className="px-5 py-3">Target Endpoint</th>
                <th className="px-5 py-3">Attempts</th>
                <th className="px-5 py-3">HTTP Response</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Timestamp</th>
                <th className="px-5 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {loading ? (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-zinc-500">Loading delivery history...</td>
                </tr>
              ) : deliveries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-zinc-500">No webhook delivery logs recorded yet.</td>
                </tr>
              ) : (
                deliveries.map((del) => (
                  <tr key={del.id} className="hover:bg-zinc-800/30 transition">
                    <td className="px-5 py-3 font-mono text-xs text-zinc-200">{del.eventType}</td>
                    <td className="px-5 py-3 text-xs">
                      <div className="font-medium text-white">{del.endpoint?.name || "Unknown"}</div>
                      <div className="text-[11px] text-zinc-500 font-mono truncate max-w-[200px]">{del.endpoint?.url}</div>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs">{del.attemptCount}</td>
                    <td className="px-5 py-3 font-mono text-xs">
                      {del.responseStatus ? (
                        <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                          del.responseStatus >= 200 && del.responseStatus < 300
                            ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                            : "bg-rose-950 text-rose-400 border border-rose-800"
                        }`}>
                          HTTP {del.responseStatus}
                        </span>
                      ) : (
                        <span className="text-zinc-500">-</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded font-bold font-mono ${
                        del.status === "DELIVERED"
                          ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                          : del.status === "FAILED"
                          ? "bg-rose-950 text-rose-400 border border-rose-800"
                          : "bg-amber-950 text-amber-400 border border-amber-800"
                      }`}>
                        {del.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-zinc-400">
                      {new Date(del.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </td>
                    <td className="px-5 py-3">
                      {del.status === "FAILED" && (
                        <button
                          onClick={() => handleRetryDelivery(del.id)}
                          className="px-2.5 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-lg text-xs transition"
                        >
                          Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Endpoint Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-4 shadow-2xl">
            <h3 className="text-lg font-bold text-white">Register Webhook Endpoint</h3>

            <form onSubmit={handleAddEndpoint} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-400 uppercase mb-1">
                  Endpoint Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Primary CRM Webhook"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 uppercase mb-1">
                  Target Webhook URL
                </label>
                <input
                  type="url"
                  required
                  placeholder="https://your-api.com/webhooks/whatsapp"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 uppercase mb-1">
                  Subscribed Event Types
                </label>
                <p className="text-[11px] text-zinc-500 mb-2">Use &apos;*&apos; for all events, or comma-separated list like &apos;message.received, message.sent&apos;</p>
                <input
                  type="text"
                  required
                  value={events.join(", ")}
                  onChange={(e) => setEvents(e.target.value.split(",").map((s) => s.trim()))}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono"
                />
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-sm transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={adding}
                  className="px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold rounded-xl text-sm transition shadow-lg shadow-emerald-500/20"
                >
                  {adding ? "Adding..." : "Save Endpoint"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Revealed Signing Secret Modal */}
      {revealedSecret && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-lg bg-zinc-900 border border-emerald-500/50 rounded-2xl p-6 space-y-5 shadow-2xl">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🔐</span>
              <div>
                <h3 className="text-lg font-bold text-white">Webhook Signing Secret</h3>
                <p className="text-xs text-amber-400 font-medium">
                  Copy this signing secret now! It will never be displayed again.
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2">
              <div className="text-xs text-zinc-400 font-mono">Signing Secret:</div>
              <div className="font-mono text-sm text-emerald-400 break-all select-all">
                {revealedSecret}
              </div>
            </div>

            <p className="text-xs text-zinc-400 leading-relaxed">
              Your receiver should verify incoming dispatches using timing-safe HMAC-SHA256 comparison against the <code className="text-emerald-400 font-mono">X-Webhook-Signature</code> header.
            </p>

            <div className="flex justify-between items-center pt-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(revealedSecret);
                  setCopiedSecret(true);
                  setTimeout(() => setCopiedSecret(false), 2000);
                }}
                className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-xl text-sm transition shadow-lg shadow-emerald-500/20 flex items-center gap-2"
              >
                <span>{copiedSecret ? "✅ Copied!" : "📋 Copy Signing Secret"}</span>
              </button>

              <button
                onClick={() => setRevealedSecret(null)}
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
