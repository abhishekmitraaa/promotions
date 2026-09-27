"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface EmailList {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  memberCount?: number;
  createdAt: string;
}

interface ListMember {
  id: string;
  listId: string;
  contactId: string;
  status: "SUBSCRIBED" | "UNSUBSCRIBED" | "CLEANED";
  unsubscribedAt: string | null;
  createdAt: string;
  contact: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    verified: boolean;
    hasMarketingConsent: boolean;
  };
}

interface AvailableContact {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export default function ListsPage() {
  const [lists, setLists] = useState<EmailList[]>([]);
  const [loading, setLoading] = useState(true);

  // Modals state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingList, setEditingList] = useState<EmailList | null>(null);
  const [activeMembersList, setActiveMembersList] = useState<EmailList | null>(null);

  // Create form
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Edit form
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Members modal state
  const [members, setMembers] = useState<ListMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersFilterStatus, setMembersFilterStatus] = useState<string>("");
  const [availableContacts, setAvailableContacts] = useState<AvailableContact[]>([]);
  const [selectedContactToAdd, setSelectedContactToAdd] = useState("");
  const [addingMember, setAddingMember] = useState(false);
  const [memberActionError, setMemberActionError] = useState<string | null>(null);

  // Bulk operations state
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkContactEmails, setBulkContactEmails] = useState("");
  const [bulkActionType, setBulkActionType] = useState<"ADD" | "REMOVE">("ADD");
  const [bulkOperating, setBulkOperating] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  async function loadLists() {
    try {
      const res = await fetch("/api/email/lists");
      if (res.ok) {
        const json = await res.json();
        setLists(json.data || []);
      }
    } catch {
      // Safe fallback
    } finally {
      setLoading(false);
    }
  }

  async function loadAvailableContacts() {
    try {
      const res = await fetch("/api/email/contacts?limit=200");
      if (res.ok) {
        const json = await res.json();
        setAvailableContacts(json.data?.contacts || []);
      }
    } catch {
      // Safe fallback
    }
  }

  useEffect(() => {
    loadLists();
    loadAvailableContacts();
  }, []);

  async function loadListMembers(listId: string, status?: string) {
    setMembersLoading(true);
    setMemberActionError(null);
    try {
      const query = status ? `?status=${encodeURIComponent(status)}` : "";
      const res = await fetch(`/api/email/lists/${listId}/members${query}`);
      if (res.ok) {
        const json = await res.json();
        setMembers(json.data?.members || []);
      }
    } catch {
      // Safe fallback
    } finally {
      setMembersLoading(false);
    }
  }

  function openMembersModal(list: EmailList) {
    setActiveMembersList(list);
    setMembersFilterStatus("");
    setSelectedContactToAdd("");
    setMemberActionError(null);
    loadListMembers(list.id);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);

    try {
      const res = await fetch("/api/email/lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: createName.trim(),
          description: createDescription.trim() || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to create list");
      }

      setShowCreateModal(false);
      setCreateName("");
      setCreateDescription("");
      loadLists();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Error creating list");
    } finally {
      setCreating(false);
    }
  }

  function openEditModal(list: EmailList) {
    setEditingList(list);
    setEditName(list.name);
    setEditDescription(list.description || "");
    setEditActive(list.active);
    setEditError(null);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingList) return;
    setEditing(true);
    setEditError(null);

    try {
      const res = await fetch(`/api/email/lists/${editingList.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          description: editDescription.trim() || null,
          active: editActive,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to update list");
      }

      setEditingList(null);
      loadLists();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Error updating list");
    } finally {
      setEditing(false);
    }
  }

  async function handleDeleteList(listId: string, name: string) {
    if (!confirm(`Are you sure you want to delete list "${name}"? Active campaigns will prevent deletion.`)) return;
    try {
      const res = await fetch(`/api/email/lists/${listId}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error?.message || "Failed to delete list");
        return;
      }
      if (activeMembersList?.id === listId) setActiveMembersList(null);
      loadLists();
    } catch {
      // Safe fallback
    }
  }

  async function handleAddSingleMember(e: React.FormEvent) {
    e.preventDefault();
    if (!activeMembersList || !selectedContactToAdd) return;
    setAddingMember(true);
    setMemberActionError(null);

    try {
      const res = await fetch(`/api/email/lists/${activeMembersList.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: selectedContactToAdd }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to add member to list");
      }

      setSelectedContactToAdd("");
      await loadListMembers(activeMembersList.id, membersFilterStatus);
      loadLists();
    } catch (err) {
      setMemberActionError(err instanceof Error ? err.message : "Failed to add member");
    } finally {
      setAddingMember(false);
    }
  }

  async function handleRemoveMember(contactId: string) {
    if (!activeMembersList) return;
    if (!confirm("Are you sure you want to remove this member from the list?")) return;
    setMemberActionError(null);

    try {
      const res = await fetch(
        `/api/email/lists/${activeMembersList.id}/members?contactId=${encodeURIComponent(contactId)}`,
        { method: "DELETE" }
      );

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to remove member");
      }

      await loadListMembers(activeMembersList.id, membersFilterStatus);
      loadLists();
    } catch (err) {
      setMemberActionError(err instanceof Error ? err.message : "Failed to remove member");
    }
  }

  async function handleBulkOperations(e: React.FormEvent) {
    e.preventDefault();
    if (!activeMembersList || !bulkContactEmails.trim()) return;
    setBulkOperating(true);
    setBulkResult(null);

    try {
      // Split input emails and resolve matching contact IDs
      const rawTokens = bulkContactEmails
        .split(/[\n,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      const matchedContactIds = availableContacts
        .filter((c) => rawTokens.includes(c.email.toLowerCase()) || rawTokens.includes(c.id))
        .map((c) => c.id);

      if (matchedContactIds.length === 0) {
        setBulkResult("No matching contacts found in tenant directory. Please verify emails.");
        return;
      }

      const res = await fetch(`/api/email/lists/${activeMembersList.id}/members`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          addContactIds: bulkActionType === "ADD" ? matchedContactIds : undefined,
          removeContactIds: bulkActionType === "REMOVE" ? matchedContactIds : undefined,
        }),
      });

      const json = await res.json();
      if (res.ok) {
        setBulkResult(`Bulk operation successful: ${matchedContactIds.length} contact(s) processed.`);
        setBulkContactEmails("");
        await loadListMembers(activeMembersList.id, membersFilterStatus);
        loadLists();
      } else {
        setBulkResult(`Bulk update failed: ${json.error?.message || "Server error"}`);
      }
    } catch (err) {
      setBulkResult(`Error: ${err instanceof Error ? err.message : "Network error"}`);
    } finally {
      setBulkOperating(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Audience Lists</h1>
          <p className="text-sm text-zinc-400">
            Static mailing lists with member subscription state tracking, duplicate prevention, and bulk operations.
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
              setCreateError(null);
              setShowCreateModal(true);
            }}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
          >
            + Create List
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-[300px]">
          <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : lists.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-12 text-center">
          <p className="text-zinc-400">No audience lists created yet.</p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="mt-4 px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
          >
            Create Your First List
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {lists.map((list) => (
            <div
              key={list.id}
              className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 hover:border-zinc-700 transition flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span
                    className={`text-xs px-2 py-0.5 rounded font-medium border ${
                      list.active
                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                        : "bg-zinc-800 text-zinc-400 border-zinc-700"
                    }`}
                  >
                    {list.active ? "Active" : "Archived"}
                  </span>
                  <span className="text-xs text-zinc-400 font-mono">
                    {list.memberCount !== undefined ? `${list.memberCount} members` : "Static List"}
                  </span>
                </div>
                <h3 className="text-base font-semibold text-white mt-2">{list.name}</h3>
                <p className="text-xs text-zinc-400 mt-1 line-clamp-2">
                  {list.description || "No description provided"}
                </p>
              </div>

              <div className="mt-5 pt-4 border-t border-zinc-800 flex items-center justify-between text-xs">
                <button
                  onClick={() => openMembersModal(list)}
                  className="text-sky-400 hover:text-sky-300 font-medium transition flex items-center gap-1"
                >
                  Manage Members &rarr;
                </button>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openEditModal(list)}
                    className="text-zinc-400 hover:text-white transition"
                  >
                    Edit
                  </button>
                  <span className="text-zinc-600">|</span>
                  <button
                    onClick={() => handleDeleteList(list.id, list.name)}
                    className="text-rose-400 hover:text-rose-300 transition"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create List Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-md w-full p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Create Audience List</h2>

            {createError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs">
                {createError}
              </div>
            )}

            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="text-xs text-zinc-400 block mb-1">List Name</label>
                <input
                  type="text"
                  required
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="e.g. VIP Newsletter Subscribers"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Description (Optional)</label>
                <textarea
                  rows={3}
                  value={createDescription}
                  onChange={(e) => setCreateDescription(e.target.value)}
                  placeholder="Target audience description..."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
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
                  disabled={creating}
                  className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  {creating ? "Creating..." : "Create List"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit List Modal */}
      {editingList && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-md w-full p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Edit Audience List</h2>

            {editError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs">
                {editError}
              </div>
            )}

            <form onSubmit={handleEdit} className="space-y-3">
              <div>
                <label className="text-xs text-zinc-400 block mb-1">List Name</label>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Description</label>
                <textarea
                  rows={3}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>
              <div className="pt-2">
                <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={editActive}
                    onChange={(e) => setEditActive(e.target.checked)}
                    className="rounded bg-zinc-950 border-zinc-700 text-sky-500 focus:ring-0"
                  />
                  <span>Active list (eligible for campaign selection)</span>
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setEditingList(null)}
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

      {/* Member Management Modal */}
      {activeMembersList && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-3xl w-full p-6 space-y-4 max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3 shrink-0">
              <div>
                <h2 className="text-lg font-bold text-white">{activeMembersList.name} — Members</h2>
                <p className="text-xs text-zinc-400">
                  Manage subscribers, view subscription states, and perform bulk membership operations.
                </p>
              </div>
              <button
                onClick={() => setActiveMembersList(null)}
                className="text-zinc-500 hover:text-white"
              >
                ✕
              </button>
            </div>

            {memberActionError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs shrink-0">
                {memberActionError}
              </div>
            )}

            {/* Add Member Bar */}
            <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 shrink-0 space-y-2">
              <div className="flex flex-col sm:flex-row items-center gap-2">
                <select
                  value={selectedContactToAdd}
                  onChange={(e) => setSelectedContactToAdd(e.target.value)}
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-sky-500"
                >
                  <option value="">-- Select Contact to Add --</option>
                  {availableContacts
                    .filter((c) => !members.some((m) => m.contactId === c.id))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.email} ({[c.firstName, c.lastName].filter(Boolean).join(" ") || "No name"})
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  disabled={!selectedContactToAdd || addingMember}
                  onClick={handleAddSingleMember}
                  className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-medium transition disabled:opacity-50"
                >
                  {addingMember ? "Adding..." : "+ Add Member"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBulkResult(null);
                    setShowBulkModal(true);
                  }}
                  className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium transition"
                >
                  Bulk Operations
                </button>
              </div>
            </div>

            {/* Filter by subscription status */}
            <div className="flex items-center justify-between text-xs text-zinc-400 shrink-0">
              <span className="font-semibold text-white">{members.length} members loaded</span>
              <div className="flex items-center gap-2">
                <span>Filter State:</span>
                <select
                  value={membersFilterStatus}
                  onChange={(e) => {
                    setMembersFilterStatus(e.target.value);
                    loadListMembers(activeMembersList.id, e.target.value);
                  }}
                  className="bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1 text-xs text-white focus:outline-none focus:border-sky-500"
                >
                  <option value="">All States</option>
                  <option value="SUBSCRIBED">SUBSCRIBED</option>
                  <option value="UNSUBSCRIBED">UNSUBSCRIBED</option>
                  <option value="CLEANED">CLEANED</option>
                </select>
              </div>
            </div>

            {/* Members Table */}
            <div className="border border-zinc-800 rounded-lg overflow-y-auto flex-1">
              {membersLoading ? (
                <div className="flex items-center justify-center p-8">
                  <div className="w-6 h-6 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
                </div>
              ) : members.length === 0 ? (
                <div className="p-8 text-center text-zinc-500 text-xs">
                  No members currently in this list matching the filter.
                </div>
              ) : (
                <table className="w-full text-left text-xs text-zinc-300">
                  <thead className="bg-zinc-800/40 text-zinc-400 border-b border-zinc-800 uppercase font-semibold">
                    <tr>
                      <th className="px-4 py-2.5">Email</th>
                      <th className="px-4 py-2.5">Name</th>
                      <th className="px-4 py-2.5">Subscription State</th>
                      <th className="px-4 py-2.5">Joined Date</th>
                      <th className="px-4 py-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {members.map((m) => (
                      <tr key={m.id} className="hover:bg-zinc-800/20 transition">
                        <td className="px-4 py-2.5 font-medium text-white">{m.contact?.email}</td>
                        <td className="px-4 py-2.5 text-zinc-400">
                          {[m.contact?.firstName, m.contact?.lastName].filter(Boolean).join(" ") || "—"}
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`px-2 py-0.5 rounded font-medium border text-[11px] ${
                              m.status === "SUBSCRIBED"
                                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                : m.status === "UNSUBSCRIBED"
                                ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                            }`}
                          >
                            {m.status}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-zinc-500">
                          {new Date(m.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={() => handleRemoveMember(m.contactId)}
                            className="text-rose-400 hover:text-rose-300 font-medium"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-zinc-800 shrink-0">
              <button
                onClick={() => setActiveMembersList(null)}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Member Operations Modal */}
      {showBulkModal && activeMembersList && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-md w-full p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Bulk Member Operations</h2>
            <p className="text-xs text-zinc-400">
              Paste email addresses separated by commas or new lines. Matching tenant contacts will be processed in bulk.
            </p>

            <form onSubmit={handleBulkOperations} className="space-y-3">
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Operation</label>
                <select
                  value={bulkActionType}
                  onChange={(e) => setBulkActionType(e.target.value as "ADD" | "REMOVE")}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                >
                  <option value="ADD">Bulk Add to List</option>
                  <option value="REMOVE">Bulk Remove from List</option>
                </select>
              </div>

              <div>
                <label className="text-xs text-zinc-400 block mb-1">Contact Email Addresses</label>
                <textarea
                  rows={5}
                  required
                  placeholder={"user1@example.com\nuser2@example.com"}
                  value={bulkContactEmails}
                  onChange={(e) => setBulkContactEmails(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs font-mono text-white focus:outline-none focus:border-sky-500"
                />
              </div>

              {bulkResult && (
                <div
                  className={`p-3 rounded-lg text-xs border ${
                    bulkResult.startsWith("Bulk operation successful")
                      ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                      : "bg-rose-500/10 border-rose-500/20 text-rose-400"
                  }`}
                >
                  {bulkResult}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowBulkModal(false)}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={bulkOperating}
                  className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  {bulkOperating ? "Processing..." : "Execute Bulk Update"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
