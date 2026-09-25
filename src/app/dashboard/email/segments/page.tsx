"use client";

import { useEffect, useState } from "react";

interface SegmentCondition {
  field: string;
  operator: string;
  value: unknown;
}

interface Segment {
  id: string;
  name: string;
  description: string | null;
  criteria: unknown;
  createdAt: string;
}

export default function SegmentsPage() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Form states
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [operator, setOperator] = useState<"AND" | "OR">("AND");
  const [requireConsent, setRequireConsent] = useState(true);

  async function loadSegments() {
    try {
      const res = await fetch("/api/email/segments");
      if (res.ok) {
        const json = await res.json();
        setSegments(json.data || []);
      }
    } catch {
      // Safe fallback
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSegments();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    try {
      const conditions: SegmentCondition[] = [];
      if (requireConsent) {
        conditions.push({
          field: "marketingConsent",
          operator: "equals",
          value: true,
        });
      }

      const res = await fetch("/api/email/segments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || undefined,
          criteria: {
            operator,
            conditions,
          },
        }),
      });

      if (res.ok) {
        setShowCreateModal(false);
        setName("");
        setDescription("");
        loadSegments();
      }
    } catch {
      // Safe fallback
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Dynamic Audience Segments</h1>
          <p className="text-sm text-zinc-400">
            Injection-proof rule-based segments dynamically evaluated at campaign snapshot time.
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
        >
          + Create Segment
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-[300px]">
          <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : segments.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-12 text-center">
          <p className="text-zinc-400">No audience segments defined yet.</p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="mt-4 px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
          >
            Create Your First Segment
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {segments.map((seg) => (
            <div
              key={seg.id}
              className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 hover:border-zinc-700 transition flex flex-col justify-between"
            >
              <div>
                <span className="text-xs px-2 py-0.5 rounded font-medium bg-sky-500/10 text-sky-400 border border-sky-500/20">
                  Dynamic Rule
                </span>
                <h3 className="text-base font-semibold text-white mt-2">{seg.name}</h3>
                <p className="text-xs text-zinc-400 mt-1 line-clamp-2">
                  {seg.description || "No description"}
                </p>
              </div>

              <div className="mt-5 pt-4 border-t border-zinc-800 flex items-center justify-between text-xs text-zinc-400">
                <span>Criteria: {JSON.stringify(seg.criteria).slice(0, 24)}...</span>
                <span className="text-sky-400 font-medium">Evaluate &rarr;</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-md w-full p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Create Audience Segment</h2>
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Segment Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Opted-In Marketing Contacts"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Description</label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Segment criteria explanation..."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Logic Match</label>
                <select
                  value={operator}
                  onChange={(e) => setOperator(e.target.value as "AND" | "OR")}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                >
                  <option value="AND">Match ALL conditions (AND)</option>
                  <option value="OR">Match ANY condition (OR)</option>
                </select>
              </div>
              <div className="pt-2">
                <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={requireConsent}
                    onChange={(e) => setRequireConsent(e.target.checked)}
                    className="rounded bg-zinc-950 border-zinc-700 text-sky-500 focus:ring-0"
                  />
                  <span>Require marketingConsent = true</span>
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
                >
                  Create Segment
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
