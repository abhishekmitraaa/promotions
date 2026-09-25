"use client";

import { useEffect, useState } from "react";

interface Contact {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
  verified: boolean;
  hasMarketingConsent: boolean;
  createdAt: string;
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [search, setSearch] = useState("");

  // Create form
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [marketingConsent, setMarketingConsent] = useState(false);

  // Import form
  const [importJson, setImportJson] = useState("");
  const [importResult, setImportResult] = useState<string | null>(null);

  async function loadContacts() {
    try {
      const res = await fetch("/api/email/contacts");
      if (res.ok) {
        const json = await res.json();
        setContacts(json.data?.contacts || []);
      }
    } catch {
      // Safe fallback
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadContacts();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch("/api/email/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          firstName: firstName || undefined,
          lastName: lastName || undefined,
          marketingConsent,
        }),
      });

      if (res.ok) {
        setShowCreateModal(false);
        setEmail("");
        setFirstName("");
        setLastName("");
        setMarketingConsent(false);
        loadContacts();
      }
    } catch {
      // Safe fallback
    }
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    try {
      let parsed = [];
      try {
        parsed = JSON.parse(importJson);
      } catch {
        // Parse CSV format if not JSON
        parsed = importJson
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [em, fn, ln, consent] = line.split(",").map((s) => s.trim());
            return {
              email: em,
              firstName: fn,
              lastName: ln,
              marketingConsent: consent === "true" || consent === "1",
            };
          });
      }

      const res = await fetch("/api/email/contacts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contacts: parsed,
          options: { deduplicate: true, skipInvalid: true }, // Non-destructive by default
        }),
      });

      if (res.ok) {
        const json = await res.json();
        setImportResult(`Successfully imported ${json.data.importedCount} contacts (skipped ${json.data.skippedCount}).`);
        loadContacts();
      }
    } catch {
      setImportResult("Failed to import contacts. Please verify format.");
    }
  }

  const filteredContacts = contacts.filter((c) =>
    c.email.toLowerCase().includes(search.toLowerCase()) ||
    (c.firstName && c.firstName.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Contacts & Consent</h1>
          <p className="text-sm text-zinc-400">
            Tenant-scoped contact management with strict verification vs marketing consent separation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowImportModal(true)}
            className="px-3.5 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-sm font-medium transition"
          >
            Import
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
          >
            + Add Contact
          </button>
        </div>
      </div>

      {/* Search Input */}
      <div className="max-w-md">
        <input
          type="text"
          placeholder="Search by email or name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3.5 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-sky-500"
        />
      </div>

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
                  <th className="px-5 py-3">Email</th>
                  <th className="px-5 py-3">Name</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Verified</th>
                  <th className="px-5 py-3">Marketing Consent</th>
                  <th className="px-5 py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {filteredContacts.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center text-zinc-500">
                      No contacts found.
                    </td>
                  </tr>
                ) : (
                  filteredContacts.map((contact) => (
                    <tr key={contact.id} className="hover:bg-zinc-800/20 transition">
                      <td className="px-5 py-3.5 font-medium text-white">{contact.email}</td>
                      <td className="px-5 py-3.5 text-zinc-400">
                        {[contact.firstName, contact.lastName].filter(Boolean).join(" ") || "—"}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="text-xs px-2 py-0.5 rounded font-medium bg-zinc-800 text-zinc-300 border border-zinc-700">
                          {contact.status}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        {contact.verified ? (
                          <span className="text-xs text-emerald-400 font-medium">Verified</span>
                        ) : (
                          <span className="text-xs text-zinc-500">Unverified</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        {contact.hasMarketingConsent ? (
                          <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                            Opted In
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700 font-medium">
                            No Consent
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-xs text-zinc-500">
                        {new Date(contact.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add Contact Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-md w-full p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Add New Contact</h2>
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Email Address</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@example.com"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">First Name</label>
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Last Name</label>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>
              <div className="pt-2">
                <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={marketingConsent}
                    onChange={(e) => setMarketingConsent(e.target.checked)}
                    className="rounded bg-zinc-950 border-zinc-700 text-sky-500 focus:ring-0"
                  />
                  <span>User has granted explicit marketing consent</span>
                </label>
                <p className="text-[11px] text-zinc-500 mt-1">
                  Required for promotional campaigns. Verifying email does not grant marketing consent.
                </p>
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
                  Save Contact
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Non-Destructive Import Modal */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-lg w-full p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Import Contacts (Non-Destructive)</h2>
            <p className="text-xs text-zinc-400">
              Paste JSON or CSV lines (email, firstName, lastName, consent). Existing contacts will not be deleted or overwritten.
            </p>
            <form onSubmit={handleImport} className="space-y-3">
              <textarea
                rows={5}
                required
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                placeholder={'user1@example.com, John, Doe, true\nuser2@example.com, Jane, Smith, false'}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs font-mono text-white focus:outline-none focus:border-sky-500"
              />
              {importResult && (
                <p className="text-xs text-emerald-400 font-medium">{importResult}</p>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowImportModal(false);
                    setImportResult(null);
                  }}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition"
                >
                  Close
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
                >
                  Start Import
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
