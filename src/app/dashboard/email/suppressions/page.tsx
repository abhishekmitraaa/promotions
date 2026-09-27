"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface SuppressionItem {
  id: string;
  email: string;
  reason: string;
  source: string | null;
  createdAt: string;
}

export default function SuppressionsPage() {
  const [suppressions, setSuppressions] = useState<SuppressionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchEmail, setSearchEmail] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newReason, setNewReason] = useState("MANUAL");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function loadSuppressions() {
    try {
      const res = await fetch("/api/email/suppressions");
      if (res.ok) {
        const json = await res.json();
        setSuppressions(json.data?.items || []);
      }
    } catch {
      // Safe fallback
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSuppressions();
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setAddError(null);
    setActionError(null);

    try {
      const res = await fetch("/api/email/suppressions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail.trim(), reason: newReason, source: "DASHBOARD_MANUAL" }),
      });

      const json = await res.json();
      if (!res.ok) {
        const msg =
          res.status === 403
            ? "Permission Denied: Adding suppressions requires ADMIN role. VIEWER accounts are strictly read-only."
            : json.error?.message || "Failed to add suppression";
        setAddError(msg);
        return;
      }

      setShowAddModal(false);
      setNewEmail("");
      loadSuppressions();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Error adding suppression");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(emailToRemove: string) {
    if (!confirm(`Are you sure you want to remove suppression for ${emailToRemove}?`)) return;
    setActionError(null);

    try {
      const res = await fetch(`/api/email/suppressions?email=${encodeURIComponent(emailToRemove)}`, {
        method: "DELETE",
      });

      const json = await res.json();
      if (!res.ok) {
        const msg =
          res.status === 403
            ? "Permission Denied: Removing suppressions requires ADMIN role. VIEWER accounts are strictly read-only."
            : json.error?.message || "Failed to remove suppression";
        setActionError(msg);
        return;
      }

      loadSuppressions();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Error removing suppression");
    }
  }

  const filtered = suppressions.filter((s) =>
    s.email.toLowerCase().includes(searchEmail.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Suppression Management</h1>
          <p className="text-sm text-zinc-400">
            Tenant-scoped suppression list protecting against sending to hard bounces, complaints, and unsubscribes.
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
              setAddError(null);
              setShowAddModal(true);
            }}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
          >
            + Add Suppression
          </button>
        </div>
      </div>

      {actionError && (
        <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-xl text-sm flex items-center justify-between">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="text-zinc-500 hover:text-white">
            ✕
          </button>
        </div>
      )}

      {/* Filter and Search */}
      <div className="max-w-md">
        <input
          type="text"
          placeholder="Search suppressed emails..."
          value={searchEmail}
          onChange={(e) => setSearchEmail(e.target.value)}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3.5 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-sky-500"
        />
      </div>

      {/* Suppressions Table */}
      {loading ? (
        <div className="flex items-center justify-center min-h-[300px]">
          <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-zinc-300">
              <thead className="bg-zinc-800/40 text-xs uppercase text-zinc-400 border-b border-zinc-800">
                <tr>
                  <th className="px-5 py-3">Suppressed Email</th>
                  <th className="px-5 py-3">Reason</th>
                  <th className="px-5 py-3">Source</th>
                  <th className="px-5 py-3">Added Date</th>
                  <th className="px-5 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-8 text-center text-zinc-500">
                      No suppression records found.
                    </td>
                  </tr>
                ) : (
                  filtered.map((s) => (
                    <tr key={s.id} className="hover:bg-zinc-800/20 transition">
                      <td className="px-5 py-3.5 font-medium text-white">{s.email}</td>
                      <td className="px-5 py-3.5">
                        <span className="text-xs px-2 py-0.5 rounded font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
                          {s.reason}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-xs text-zinc-400">{s.source || "SYSTEM"}</td>
                      <td className="px-5 py-3.5 text-xs text-zinc-500">
                        {new Date(s.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-5 py-3.5">
                        <button
                          onClick={() => handleRemove(s.email)}
                          className="text-xs text-rose-400 hover:text-rose-300 font-medium"
                          title="Remove suppression (ADMIN only)"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-md w-full p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Add Email Suppression</h2>

            {addError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs">
                {addError}
              </div>
            )}

            <form onSubmit={handleAdd} className="space-y-3">
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Email Address</label>
                <input
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="user@example.com"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Suppression Reason</label>
                <select
                  value={newReason}
                  onChange={(e) => setNewReason(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                >
                  <option value="MANUAL">MANUAL (Admin decision)</option>
                  <option value="HARD_BOUNCE">HARD_BOUNCE (Invalid address)</option>
                  <option value="COMPLAINT">COMPLAINT (Spam report)</option>
                  <option value="UNSUBSCRIBED">UNSUBSCRIBED (User request)</option>
                  <option value="INVALID">INVALID (Syntax error)</option>
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={adding}
                  className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  {adding ? "Adding..." : "Add Suppression"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
