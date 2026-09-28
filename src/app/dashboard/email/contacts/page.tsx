"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Contact {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: "SUBSCRIBED" | "UNSUBSCRIBED" | "BOUNCED" | "COMPLAINED";
  verified: boolean;
  hasMarketingConsent: boolean;
  consentSource?: string | null;
  consentTimestamp?: string | null;
  metadata?: string | null;
  createdAt: string;
  isSuppressed?: boolean;
  suppressionReason?: string | null;
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterConsent, setFilterConsent] = useState<string>("");
  const [filterVerified, setFilterVerified] = useState<string>("");

  // Modals state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [inspectContact, setInspectContact] = useState<Contact | null>(null);
  const [inspectSuppression, setInspectSuppression] = useState<{ isSuppressed: boolean; reason?: string } | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);

  // Edit modal
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [editFirstName, setEditFirstName] = useState("");
  const [editLastName, setEditLastName] = useState("");
  const [editStatus, setEditStatus] = useState<"SUBSCRIBED" | "UNSUBSCRIBED" | "BOUNCED" | "COMPLAINED">("SUBSCRIBED");
  const [editConsent, setEditConsent] = useState(false);
  const [editVerified, setEditVerified] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Create form state
  const [createEmail, setCreateEmail] = useState("");
  const [createFirstName, setCreateFirstName] = useState("");
  const [createLastName, setCreateLastName] = useState("");
  const [createConsent, setCreateConsent] = useState(false);
  const [createConsentSource, setCreateConsentSource] = useState("WEB_FORM");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Import form state
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  async function loadContacts() {
    try {
      const res = await fetch("/api/email/contacts?limit=100");
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
    setCreating(true);
    setCreateError(null);

    try {
      const res = await fetch("/api/email/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: createEmail.trim(),
          firstName: createFirstName.trim() || undefined,
          lastName: createLastName.trim() || undefined,
          marketingConsent: createConsent,
          consentSource: createConsent ? createConsentSource : undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to create contact");
      }

      setShowCreateModal(false);
      setCreateEmail("");
      setCreateFirstName("");
      setCreateLastName("");
      setCreateConsent(false);
      await loadContacts();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create contact");
    } finally {
      setCreating(false);
    }
  }

  function openEditModal(c: Contact) {
    setEditingContact(c);
    setEditFirstName(c.firstName || "");
    setEditLastName(c.lastName || "");
    setEditStatus(c.status);
    setEditConsent(c.hasMarketingConsent);
    setEditVerified(c.verified);
    setEditError(null);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingContact) return;
    setEditing(true);
    setEditError(null);

    try {
      const res = await fetch(`/api/email/contacts/${editingContact.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: editFirstName.trim() || undefined,
          lastName: editLastName.trim() || undefined,
          status: editStatus,
          hasMarketingConsent: editConsent,
          verified: editVerified,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to update contact");
      }

      setEditingContact(null);
      await loadContacts();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Error updating contact");
    } finally {
      setEditing(false);
    }
  }

  async function handleInspect(contact: Contact) {
    setInspectContact(contact);
    setInspectSuppression(null);
    setInspectLoading(true);

    try {
      const res = await fetch(`/api/email/suppressions?email=${encodeURIComponent(contact.email)}`);
      if (res.ok) {
        const json = await res.json();
        setInspectSuppression({
          isSuppressed: Boolean(json.data?.suppressed),
          reason: json.data?.reason || undefined,
        });
      }
    } catch {
      // Safe fallback
    } finally {
      setInspectLoading(false);
    }
  }

  async function handleDelete(contactId: string, email: string) {
    if (!confirm(`Are you sure you want to delete contact ${email}?`)) return;
    try {
      const res = await fetch(`/api/email/contacts/${contactId}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error?.message || "Failed to delete contact");
        return;
      }
      if (inspectContact?.id === contactId) setInspectContact(null);
      loadContacts();
    } catch {
      // Safe fallback
    }
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    setImporting(true);
    setImportResult(null);

    try {
      let parsed = [];
      try {
        parsed = JSON.parse(importText);
      } catch {
        // Parse CSV format if not JSON: email,firstName,lastName,marketingConsent
        parsed = importText
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const parts = line.split(",").map((s) => s.trim());
            return {
              email: parts[0],
              firstName: parts[1] || undefined,
              lastName: parts[2] || undefined,
              marketingConsent: parts[3] === "true" || parts[3] === "1",
            };
          });
      }

      const res = await fetch("/api/email/contacts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contacts: parsed,
          options: { deduplicate: true, skipInvalid: true },
        }),
      });

      const json = await res.json();
      if (res.ok) {
        setImportResult(
          `Import complete: ${json.data?.importedCount ?? 0} imported, ${json.data?.skippedCount ?? 0} duplicate/invalid skipped.`
        );
        loadContacts();
      } else {
        setImportResult(`Import failed: ${json.error?.message || "Invalid payload format"}`);
      }
    } catch (err) {
      setImportResult(`Error: ${err instanceof Error ? err.message : "Failed to parse import data"}`);
    } finally {
      setImporting(false);
    }
  }

  const filteredContacts = contacts.filter((c) => {
    const matchSearch =
      c.email.toLowerCase().includes(search.toLowerCase()) ||
      (c.firstName && c.firstName.toLowerCase().includes(search.toLowerCase())) ||
      (c.lastName && c.lastName.toLowerCase().includes(search.toLowerCase()));

    const matchConsent =
      filterConsent === ""
        ? true
        : filterConsent === "yes"
        ? c.hasMarketingConsent
        : !c.hasMarketingConsent;

    const matchVerified =
      filterVerified === ""
        ? true
        : filterVerified === "yes"
        ? c.verified
        : !c.verified;

    return matchSearch && matchConsent && matchVerified;
  });

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Contacts & Audience</h1>
          <p className="text-sm text-zinc-400">
            Tenant-scoped contact directory with strict boundary between Email Verification and Marketing Consent.
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
              setImportResult(null);
              setShowImportModal(true);
            }}
            className="px-3.5 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-sm font-medium transition"
          >
            Import Contacts
          </button>
          <button
            onClick={() => {
              setCreateError(null);
              setShowCreateModal(true);
            }}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
          >
            + Add Contact
          </button>
        </div>
      </div>

      {/* Critical Legal Distinction Banner */}
      <div className="p-3.5 bg-sky-950/20 border border-sky-800/40 rounded-xl text-xs text-sky-200 flex items-start gap-2.5">
        <span className="text-base shrink-0">ℹ️</span>
        <div>
          <strong className="text-white">Deliverability vs Legal Consent Separation:</strong>
          <span className="opacity-90 ml-1">
            <strong>Email Verification</strong> certifies syntax and MX deliverability. 
            <strong> Marketing Consent</strong> certifies explicit opt-in under CAN-SPAM/GDPR law. Verifying an email address NEVER grants marketing consent.
          </span>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[240px]">
          <input
            type="text"
            placeholder="Search contacts by email or name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3.5 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-sky-500"
          />
        </div>

        <select
          value={filterConsent}
          onChange={(e) => setFilterConsent(e.target.value)}
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-sky-500"
        >
          <option value="">All Consent States</option>
          <option value="yes">Opted In (Has Consent)</option>
          <option value="no">No Consent</option>
        </select>

        <select
          value={filterVerified}
          onChange={(e) => setFilterVerified(e.target.value)}
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-sky-500"
        >
          <option value="">All Verification States</option>
          <option value="yes">Verified</option>
          <option value="no">Unverified</option>
        </select>
      </div>

      {/* Contacts Table */}
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
                  <th className="px-5 py-3">Deliverability Verification</th>
                  <th className="px-5 py-3">Marketing Consent</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {filteredContacts.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center text-zinc-500">
                      No matching contacts found.
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
                        {contact.verified ? (
                          <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                            ✓ Verified
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">
                            Unverified
                          </span>
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
                      <td className="px-5 py-3.5">
                        <span className="text-xs px-2 py-0.5 rounded font-medium bg-zinc-800 text-zinc-300 border border-zinc-700">
                          {contact.status}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2 text-xs">
                          <button
                            onClick={() => handleInspect(contact)}
                            className="text-sky-400 hover:text-sky-300 font-medium transition"
                          >
                            Inspect
                          </button>
                          <span className="text-zinc-600">|</span>
                          <button
                            onClick={() => openEditModal(contact)}
                            className="text-zinc-300 hover:text-white transition"
                          >
                            Edit
                          </button>
                          <span className="text-zinc-600">|</span>
                          <button
                            onClick={() => handleDelete(contact.id, contact.email)}
                            className="text-rose-400 hover:text-rose-300 transition"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Inspect Contact Drawer/Modal */}
      {inspectContact && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div>
                <h2 className="text-lg font-bold text-white">{inspectContact.email}</h2>
                <p className="text-xs text-zinc-400">Contact Details & Suppression Inspection</p>
              </div>
              <button
                onClick={() => setInspectContact(null)}
                className="text-zinc-500 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 bg-zinc-950 p-4 rounded-xl border border-zinc-800 text-xs">
              <div className="flex justify-between py-1 border-b border-zinc-800">
                <span className="text-zinc-400">Contact ID:</span>
                <span className="font-mono text-zinc-300">{inspectContact.id}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-800">
                <span className="text-zinc-400">Full Name:</span>
                <span className="text-white font-medium">
                  {[inspectContact.firstName, inspectContact.lastName].filter(Boolean).join(" ") || "None"}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-800">
                <span className="text-zinc-400">Subscription Status:</span>
                <span className="text-zinc-200 font-medium">{inspectContact.status}</span>
              </div>

              {/* Email Verification Box */}
              <div className="py-2 border-b border-zinc-800">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-zinc-400 font-medium">Email Verification (Deliverability):</span>
                  {inspectContact.verified ? (
                    <span className="text-emerald-400 font-semibold">✓ Verified Address</span>
                  ) : (
                    <span className="text-zinc-500">Unverified</span>
                  )}
                </div>
                <p className="text-[11px] text-zinc-500">
                  Validates email address syntax and existence. Does not permit marketing sends.
                </p>
              </div>

              {/* Marketing Consent Box */}
              <div className="py-2 border-b border-zinc-800">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-zinc-400 font-medium">Marketing Consent (GDPR/Opt-In):</span>
                  {inspectContact.hasMarketingConsent ? (
                    <span className="text-emerald-400 font-semibold">✓ Explicit Consent Active</span>
                  ) : (
                    <span className="text-amber-400 font-semibold">No Consent</span>
                  )}
                </div>
                <p className="text-[11px] text-zinc-500">
                  Source: {inspectContact.consentSource || "Direct Web API"} | Required for promotional campaigns.
                </p>
              </div>

              {/* Suppression Status Check */}
              <div className="py-2">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-zinc-400 font-medium">Suppression List Status:</span>
                  {inspectLoading ? (
                    <span className="text-zinc-500">Checking registry...</span>
                  ) : inspectSuppression?.isSuppressed ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20 font-bold">
                      SUPPRESSED ({inspectSuppression.reason || "ACTIVE"})
                    </span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                      Not Suppressed
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-zinc-500">
                  Suppressed contacts are automatically skipped by campaign workers to protect sender reputation.
                </p>
              </div>

              {/* Metadata */}
              {inspectContact.metadata && (
                <div className="pt-2 border-t border-zinc-800">
                  <span className="text-zinc-400 block mb-1">Custom Attributes / Metadata:</span>
                  <pre className="p-2 bg-zinc-900 rounded font-mono text-[11px] text-zinc-300 overflow-x-auto">
                    {inspectContact.metadata}
                  </pre>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
              <button
                onClick={() => {
                  const target = inspectContact;
                  setInspectContact(null);
                  openEditModal(target);
                }}
                className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
              >
                Edit Contact
              </button>
              <button
                onClick={() => setInspectContact(null)}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Contact Modal */}
      {editingContact && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-md w-full p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Edit Contact</h2>
            <p className="text-xs text-zinc-400">{editingContact.email}</p>

            {editError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs">
                {editError}
              </div>
            )}

            <form onSubmit={handleEdit} className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">First Name</label>
                  <input
                    type="text"
                    value={editFirstName}
                    onChange={(e) => setEditFirstName(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Last Name</label>
                  <input
                    type="text"
                    value={editLastName}
                    onChange={(e) => setEditLastName(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-zinc-400 block mb-1">Subscription Status</label>
                <select
                  value={editStatus}
                  onChange={(e) =>
                    setEditStatus(
                      e.target.value as "SUBSCRIBED" | "UNSUBSCRIBED" | "BOUNCED" | "COMPLAINED"
                    )
                  }
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                >
                  <option value="SUBSCRIBED">SUBSCRIBED</option>
                  <option value="UNSUBSCRIBED">UNSUBSCRIBED</option>
                  <option value="BOUNCED">BOUNCED</option>
                  <option value="COMPLAINED">COMPLAINED</option>
                </select>
              </div>

              <div className="pt-2 border-t border-zinc-800 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={editVerified}
                    onChange={(e) => setEditVerified(e.target.checked)}
                    className="rounded bg-zinc-950 border-zinc-700 text-sky-500 focus:ring-0"
                  />
                  <span>Email verified (deliverable address)</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={editConsent}
                    onChange={(e) => setEditConsent(e.target.checked)}
                    className="rounded bg-zinc-950 border-zinc-700 text-sky-500 focus:ring-0"
                  />
                  <span>Has explicit marketing consent (opted-in)</span>
                </label>
                <p className="text-[11px] text-zinc-500 pl-6">
                  Warning: Marketing consent requires documented subscriber permission under law.
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setEditingContact(null)}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editing}
                  className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  {editing ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Contact Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-md w-full p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Add New Contact</h2>

            {createError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs">
                {createError}
              </div>
            )}

            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Email Address</label>
                <input
                  type="email"
                  required
                  value={createEmail}
                  onChange={(e) => setCreateEmail(e.target.value)}
                  placeholder="user@example.com"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">First Name</label>
                  <input
                    type="text"
                    value={createFirstName}
                    onChange={(e) => setCreateFirstName(e.target.value)}
                    placeholder="John"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Last Name</label>
                  <input
                    type="text"
                    value={createLastName}
                    onChange={(e) => setCreateLastName(e.target.value)}
                    placeholder="Doe"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>
              <div className="pt-2 border-t border-zinc-800">
                <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={createConsent}
                    onChange={(e) => setCreateConsent(e.target.checked)}
                    className="rounded bg-zinc-950 border-zinc-700 text-sky-500 focus:ring-0"
                  />
                  <span>User has granted explicit marketing consent</span>
                </label>
                <p className="text-[11px] text-zinc-500 mt-1 pl-6">
                  Required for promotional campaigns. Verifying email address does NOT grant consent.
                </p>
              </div>

              {createConsent && (
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Consent Source</label>
                  <input
                    type="text"
                    value={createConsentSource}
                    onChange={(e) => setCreateConsentSource(e.target.value)}
                    placeholder="e.g. WEBSITE_SIGNUP_CHECKBOX"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
              )}

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
                  disabled={creating}
                  className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  {creating ? "Saving..." : "Save Contact"}
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
              Paste JSON or CSV lines formatted as: <code className="text-zinc-200">email, firstName, lastName, marketingConsent</code>. Existing contacts will not be deleted or overwritten.
            </p>
            <form onSubmit={handleImport} className="space-y-3">
              <textarea
                rows={6}
                required
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={'user1@example.com, John, Doe, true\nuser2@example.com, Jane, Smith, false'}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs font-mono text-white focus:outline-none focus:border-sky-500"
              />
              {importResult && (
                <div
                  className={`p-3 rounded-lg text-xs border ${
                    importResult.startsWith("Import complete")
                      ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                      : "bg-rose-500/10 border-rose-500/20 text-rose-400"
                  }`}
                >
                  {importResult}
                </div>
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
                  disabled={importing}
                  className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  {importing ? "Importing..." : "Start Import"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
