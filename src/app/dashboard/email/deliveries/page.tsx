"use client";

import { useCallback, useEffect, useState } from "react";

interface DeliveryItem {
  id: string;
  category: string;
  from: string;
  to: string;
  subject: string;
  status: string;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  createdAt: string;
  events: Array<{
    id: string;
    eventType: string;
    occurredAt: string;
  }>;
}

export default function DeliveriesPage() {
  const [deliveries, setDeliveries] = useState<DeliveryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [selectedDelivery, setSelectedDelivery] = useState<DeliveryItem | null>(null);

  const loadDeliveries = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (categoryFilter) params.set("category", categoryFilter);
      if (toFilter) params.set("to", toFilter);

      const res = await fetch(`/api/email/deliveries?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setDeliveries(json.data?.items || []);
      }
    } catch {
      // Safe fallback
    } finally {
      setLoading(false);
    }
  }, [statusFilter, categoryFilter, toFilter]);

  useEffect(() => {
    loadDeliveries();
  }, [loadDeliveries]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Email Deliveries</h1>
        <p className="text-sm text-zinc-400">
          Delivery status telemetry and complete event timeline history.
        </p>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-sky-500"
        >
          <option value="">All Statuses</option>
          <option value="QUEUED">QUEUED</option>
          <option value="SENT">SENT</option>
          <option value="DELIVERED">DELIVERED</option>
          <option value="BOUNCED">BOUNCED</option>
          <option value="COMPLAINED">COMPLAINED</option>
          <option value="FAILED">FAILED</option>
        </select>

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-sky-500"
        >
          <option value="">All Categories</option>
          <option value="TRANSACTIONAL">TRANSACTIONAL</option>
          <option value="PROMOTIONAL">PROMOTIONAL</option>
        </select>

        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Filter by recipient..."
            value={toFilter}
            onChange={(e) => setToFilter(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-sky-500"
          />
          <button
            onClick={loadDeliveries}
            className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium transition"
          >
            Apply
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-[300px]">
          <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : deliveries.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-12 text-center text-zinc-400">
          No delivery records match the current filter.
        </div>
      ) : (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-zinc-300">
              <thead className="bg-zinc-800/40 text-xs uppercase text-zinc-400 border-b border-zinc-800">
                <tr>
                  <th className="px-5 py-3">Recipient</th>
                  <th className="px-5 py-3">Subject</th>
                  <th className="px-5 py-3">Type</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Events</th>
                  <th className="px-5 py-3">Created</th>
                  <th className="px-5 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {deliveries.map((del) => (
                  <tr key={del.id} className="hover:bg-zinc-800/20 transition">
                    <td className="px-5 py-3.5 font-medium text-white">{del.to}</td>
                    <td className="px-5 py-3.5 text-zinc-400 max-w-xs truncate">{del.subject}</td>
                    <td className="px-5 py-3.5 text-xs text-zinc-400">{del.category}</td>
                    <td className="px-5 py-3.5">
                      <span className="text-xs px-2 py-0.5 rounded font-medium bg-zinc-800 text-zinc-300 border border-zinc-700">
                        {del.status}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-xs text-zinc-400">
                      {del.events?.length || 0} events
                    </td>
                    <td className="px-5 py-3.5 text-xs text-zinc-500">
                      {new Date(del.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="px-5 py-3.5">
                      <button
                        onClick={() => setSelectedDelivery(del)}
                        className="text-xs text-sky-400 hover:text-sky-300 font-medium"
                      >
                        Timeline &rarr;
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Timeline Modal */}
      {selectedDelivery && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div>
                <h2 className="text-base font-bold text-white">Delivery Timeline</h2>
                <p className="text-xs text-zinc-400">{selectedDelivery.to}</p>
              </div>
              <button
                onClick={() => setSelectedDelivery(null)}
                className="text-zinc-500 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 max-h-[350px] overflow-y-auto">
              <div className="text-xs space-y-1 bg-zinc-950 p-3 rounded-lg border border-zinc-800">
                <p className="text-zinc-400">
                  <strong className="text-white">Subject:</strong> {selectedDelivery.subject}
                </p>
                <p className="text-zinc-400">
                  <strong className="text-white">Category:</strong> {selectedDelivery.category}
                </p>
                <p className="text-zinc-400">
                  <strong className="text-white">Final Status:</strong> {selectedDelivery.status}
                </p>
              </div>

              <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                Event History
              </h3>

              {selectedDelivery.events?.length === 0 ? (
                <p className="text-xs text-zinc-500 italic">No webhook events logged yet.</p>
              ) : (
                <div className="space-y-2">
                  {selectedDelivery.events?.map((evt) => (
                    <div
                      key={evt.id}
                      className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-950 border border-zinc-800/80 text-xs"
                    >
                      <span className="font-medium text-sky-400">{evt.eventType}</span>
                      <span className="text-zinc-500">
                        {new Date(evt.occurredAt).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
