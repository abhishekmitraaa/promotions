"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface OverviewData {
  success: boolean;
  stats: {
    totalMessages: number;
    outboundCount: number;
    inboundCount: number;
    failedCount: number;
  };
  health: {
    database: string;
    metaCloudApi: string;
  };
  recentMessages: Array<{
    id: string;
    providerMessageId?: string;
    direction: "INBOUND" | "OUTBOUND";
    type: string;
    status: string;
    to: string;
    from: string;
    body?: string;
    createdAt: string;
  }>;
}

export default function DashboardOverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  async function fetchOverviewData() {
    try {
      const res = await fetch("/api/admin/overview");
      const json = await res.json();
      if (json.success) {
        setData(json);
      }
    } catch (err) {
      console.error("Failed to fetch dashboard stats:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchOverviewData();
  }, []);

  return (
    <div className="space-y-8">
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gradient-to-r from-zinc-900 via-zinc-900 to-emerald-950/40 p-6 rounded-2xl border border-zinc-800">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Messaging Infrastructure Dashboard</h2>
          <p className="text-zinc-400 text-sm mt-1">
            Real-time status, outbound dispatching, and incoming Meta webhook pipeline.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/messages"
            className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold text-sm transition shadow-lg shadow-emerald-500/20 flex items-center gap-2"
          >
            <span>🚀</span> Send WhatsApp Message
          </Link>
        </div>
      </div>

      {/* Meta Config Status Banner */}
      {data?.health.metaCloudApi === "unconfigured" && (
        <div className="p-4 rounded-xl bg-amber-950/40 border border-amber-800/60 text-amber-200 text-sm flex items-start gap-3">
          <span className="text-xl">⚠️</span>
          <div>
            <div className="font-semibold text-amber-100">Meta API Credentials Not Configured</div>
            <p className="text-amber-300/80 text-xs mt-0.5">
              The service is currently running in local development simulation mode. To send live WhatsApp messages, configure <code className="bg-amber-900/60 px-1 py-0.5 rounded text-amber-100 font-mono">META_ACCESS_TOKEN</code> and <code className="bg-amber-900/60 px-1 py-0.5 rounded text-amber-100 font-mono">META_PHONE_NUMBER_ID</code> in your <code className="bg-amber-900/60 px-1 py-0.5 rounded text-amber-100 font-mono">.env.local</code> file.
            </p>
          </div>
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <div className="bg-zinc-900/60 border border-zinc-800/80 p-5 rounded-2xl">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Total Messages</div>
          <div className="text-3xl font-extrabold text-white mt-2">
            {loading ? "..." : data?.stats.totalMessages ?? 0}
          </div>
          <div className="text-xs text-zinc-500 mt-1">Combined inbound & outbound</div>
        </div>

        <div className="bg-zinc-900/60 border border-zinc-800/80 p-5 rounded-2xl">
          <div className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Outbound Sent</div>
          <div className="text-3xl font-extrabold text-white mt-2">
            {loading ? "..." : data?.stats.outboundCount ?? 0}
          </div>
          <div className="text-xs text-zinc-500 mt-1">API & Dashboard dispatches</div>
        </div>

        <div className="bg-zinc-900/60 border border-zinc-800/80 p-5 rounded-2xl">
          <div className="text-xs font-semibold text-sky-400 uppercase tracking-wider">Inbound Received</div>
          <div className="text-3xl font-extrabold text-white mt-2">
            {loading ? "..." : data?.stats.inboundCount ?? 0}
          </div>
          <div className="text-xs text-zinc-500 mt-1">From Meta Webhook</div>
        </div>

        <div className="bg-zinc-900/60 border border-zinc-800/80 p-5 rounded-2xl">
          <div className="text-xs font-semibold text-rose-400 uppercase tracking-wider">Failed Messages</div>
          <div className="text-3xl font-extrabold text-white mt-2">
            {loading ? "..." : data?.stats.failedCount ?? 0}
          </div>
          <div className="text-xs text-zinc-500 mt-1">Delivery error logs</div>
        </div>
      </div>

      {/* System Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-zinc-900/40 border border-zinc-800 p-6 rounded-2xl space-y-4">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <span>🛡️</span> Security & Service Status
          </h3>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between items-center py-2 border-b border-zinc-800/60">
              <span className="text-zinc-400">Database Connection</span>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-950 text-emerald-400 border border-emerald-800">
                {data?.health.database || "SQLite Active"}
              </span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-zinc-800/60">
              <span className="text-zinc-400">Meta API Status</span>
              <span
                className={`px-2.5 py-0.5 rounded-full text-xs font-medium border ${
                  data?.health.metaCloudApi === "configured"
                    ? "bg-emerald-950 text-emerald-400 border-emerald-800"
                    : "bg-amber-950 text-amber-400 border-amber-800"
                }`}
              >
                {data?.health.metaCloudApi === "configured" ? "Configured & Ready" : "Dev Simulation"}
              </span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-zinc-400">Public API Version</span>
              <span className="text-zinc-200 font-mono text-xs bg-zinc-800 px-2 py-1 rounded">/api/v1</span>
            </div>
          </div>
        </div>

        <div className="bg-zinc-900/40 border border-zinc-800 p-6 rounded-2xl space-y-4">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <span>⚡</span> Quick Integration Snippet
          </h3>
          <p className="text-xs text-zinc-400">
            Send outbound WhatsApp messages directly using standard HTTP request with your generated API key.
          </p>
          <pre className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs font-mono text-emerald-400 overflow-x-auto">
{`curl -X POST http://localhost:3000/api/v1/messages \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "919876543210",
    "type": "text",
    "body": "Hello from external app!"
  }'`}
          </pre>
        </div>
      </div>

      {/* Recent Activity Table */}
      <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl overflow-hidden">
        <div className="p-5 border-b border-zinc-800 flex justify-between items-center">
          <h3 className="font-semibold text-white">Recent Message Activity</h3>
          <Link href="/dashboard/messages" className="text-xs text-emerald-400 hover:underline">
            View All →
          </Link>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-zinc-300">
            <thead className="bg-zinc-900/80 text-xs uppercase text-zinc-400 font-semibold border-b border-zinc-800">
              <tr>
                <th className="px-5 py-3">Direction</th>
                <th className="px-5 py-3">Type</th>
                <th className="px-5 py-3">Recipient / Sender</th>
                <th className="px-5 py-3">Content Snippet</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {loading ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-zinc-500">
                    Loading recent activity...
                  </td>
                </tr>
              ) : !data?.recentMessages || data.recentMessages.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-zinc-500">
                    No message activity recorded yet.
                  </td>
                </tr>
              ) : (
                data.recentMessages.map((msg) => (
                  <tr key={msg.id} className="hover:bg-zinc-800/40 transition">
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-block px-2 py-0.5 text-xs font-semibold rounded ${
                          msg.direction === "OUTBOUND"
                            ? "bg-emerald-950 text-emerald-400 border border-emerald-800/60"
                            : "bg-sky-950 text-sky-400 border border-sky-800/60"
                        }`}
                      >
                        {msg.direction}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-zinc-400">{msg.type}</td>
                    <td className="px-5 py-3.5 font-mono text-xs text-white">
                      {msg.direction === "OUTBOUND" ? msg.to : msg.from}
                    </td>
                    <td className="px-5 py-3.5 max-w-xs truncate text-zinc-300">
                      {msg.body || "[No Body Content]"}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-medium">
                        {msg.status}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-xs text-zinc-500">
                      {new Date(msg.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
