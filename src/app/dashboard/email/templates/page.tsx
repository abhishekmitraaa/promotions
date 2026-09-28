"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface TemplateVersion {
  id: string;
  version: number;
  subject: string;
  htmlContent: string;
  textContent: string | null;
  status: string;
  createdAt: string;
}

interface TemplateItem {
  id: string;
  name: string;
  description: string | null;
  type: string;
  activeVersionId: string | null;
  activeVersion: TemplateVersion | null;
  versions: TemplateVersion[];
  createdAt: string;
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateItem | null>(null);
  const [inspectorTab, setInspectorTab] = useState<"preview" | "versions" | "new_version" | "metadata" | "test_send">("preview");

  // Create Template form states
  const [createName, setCreateName] = useState("");
  const [createSubject, setCreateSubject] = useState("");
  const [createHtmlContent, setCreateHtmlContent] = useState("");
  const [createTextContent, setCreateTextContent] = useState("");
  const [createType, setCreateType] = useState<"PROMOTIONAL" | "TRANSACTIONAL">("PROMOTIONAL");
  const [createDescription, setCreateDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Edit Metadata form states
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editType, setEditType] = useState<"PROMOTIONAL" | "TRANSACTIONAL">("PROMOTIONAL");
  const [updatingMetadata, setUpdatingMetadata] = useState(false);
  const [metadataMsg, setMetadataMsg] = useState<{ text: string; error?: boolean } | null>(null);

  // New Version form states
  const [newVersionSubject, setNewVersionSubject] = useState("");
  const [newVersionHtml, setNewVersionHtml] = useState("");
  const [newVersionText, setNewVersionText] = useState("");
  const [creatingVersion, setCreatingVersion] = useState(false);
  const [versionMsg, setVersionMsg] = useState<{ text: string; error?: boolean } | null>(null);

  // Inspecting a specific historical version
  const [inspectedVersion, setInspectedVersion] = useState<TemplateVersion | null>(null);

  // Test Send state
  const [testSendEmail, setTestSendEmail] = useState("");
  const [testSendLoading, setTestSendLoading] = useState(false);
  const [testSendResult, setTestSendResult] = useState<{ text: string; error?: boolean } | null>(null);

  async function loadTemplates() {
    try {
      const res = await fetch("/api/email/templates");
      if (res.ok) {
        const json = await res.json();
        setTemplates(json.data || []);
      }
    } catch {
      // Safe fallback
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTemplates();
  }, []);

  function openInspector(template: TemplateItem, initialTab: "preview" | "versions" | "new_version" | "metadata" | "test_send" = "preview") {
    setSelectedTemplate(template);
    setInspectorTab(initialTab);
    setInspectedVersion(template.activeVersion || template.versions[0] || null);

    // Populate edit fields
    setEditName(template.name);
    setEditDescription(template.description || "");
    setEditType((template.type as "PROMOTIONAL" | "TRANSACTIONAL") || "PROMOTIONAL");

    // Populate new version template from active
    const activeVer = template.activeVersion || template.versions[0];
    if (activeVer) {
      setNewVersionSubject(activeVer.subject);
      setNewVersionHtml(activeVer.htmlContent);
      setNewVersionText(activeVer.textContent || "");
    }

    setMetadataMsg(null);
    setVersionMsg(null);
    setTestSendResult(null);
  }

  async function handleCreateTemplate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);

    try {
      const res = await fetch("/api/email/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: createName.trim(),
          description: createDescription.trim() || undefined,
          type: createType,
          subject: createSubject.trim(),
          htmlContent: createHtmlContent,
          textContent: createTextContent || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to create template");
      }

      setShowCreateModal(false);
      setCreateName("");
      setCreateDescription("");
      setCreateSubject("");
      setCreateHtmlContent("");
      setCreateTextContent("");
      await loadTemplates();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create template");
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdateMetadata(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedTemplate) return;
    setUpdatingMetadata(true);
    setMetadataMsg(null);

    try {
      const res = await fetch(`/api/email/templates/${selectedTemplate.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          description: editDescription.trim() || null,
          type: editType,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to update template metadata");
      }

      setMetadataMsg({ text: "Metadata updated successfully!" });
      await loadTemplates();
      setSelectedTemplate((prev) => prev ? { ...prev, name: editName, description: editDescription, type: editType } : null);
    } catch (err) {
      setMetadataMsg({ text: err instanceof Error ? err.message : "Error updating metadata", error: true });
    } finally {
      setUpdatingMetadata(false);
    }
  }

  async function handleCreateVersion(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedTemplate) return;
    setCreatingVersion(true);
    setVersionMsg(null);

    try {
      const res = await fetch(`/api/email/templates/${selectedTemplate.id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: newVersionSubject.trim(),
          htmlContent: newVersionHtml,
          textContent: newVersionText || null,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to create template version");
      }

      setVersionMsg({ text: `Version ${json.data.version} created and activated successfully!` });
      await loadTemplates();

      // Refresh current inspector
      const updatedRes = await fetch(`/api/email/templates/${selectedTemplate.id}`);
      if (updatedRes.ok) {
        const updatedJson = await updatedRes.json();
        setSelectedTemplate(updatedJson.data);
        setInspectedVersion(updatedJson.data.activeVersion || updatedJson.data.versions[0]);
      }
      setInspectorTab("preview");
    } catch (err) {
      setVersionMsg({ text: err instanceof Error ? err.message : "Error creating version", error: true });
    } finally {
      setCreatingVersion(false);
    }
  }

  async function handleSetActiveVersion(versionId: string) {
    if (!selectedTemplate) return;
    try {
      const res = await fetch(`/api/email/templates/${selectedTemplate.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeVersionId: versionId }),
      });

      const json = await res.json();
      if (!res.ok) {
        alert(json.error?.message || "Failed to set active version");
        return;
      }

      await loadTemplates();
      const updatedRes = await fetch(`/api/email/templates/${selectedTemplate.id}`);
      if (updatedRes.ok) {
        const updatedJson = await updatedRes.json();
        setSelectedTemplate(updatedJson.data);
        setInspectedVersion(updatedJson.data.activeVersion);
      }
    } catch {
      // Safe fallback
    }
  }

  async function handleSendTest(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedTemplate || !testSendEmail.trim()) return;
    setTestSendLoading(true);
    setTestSendResult(null);

    try {
      const res = await fetch(`/api/email/templates/${selectedTemplate.id}/test-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testEmail: testSendEmail.trim(),
          versionId: inspectedVersion?.id || selectedTemplate.activeVersionId || undefined,
        }),
      });

      const json = await res.json();
      if (res.ok && json.success) {
        setTestSendResult({
          text: `Test email dispatched to ${json.data.sentTo} ${json.data.providerMessageId ? `(Message ID: ${json.data.providerMessageId})` : "(Dispatched)"}`,
        });
      } else {
        setTestSendResult({
          text: json.error?.message || "Failed to dispatch test email",
          error: true,
        });
      }
    } catch (err) {
      setTestSendResult({
        text: err instanceof Error ? err.message : "Network error",
        error: true,
      });
    } finally {
      setTestSendLoading(false);
    }
  }

  async function handleDeleteTemplate(templateId: string) {
    if (!confirm("Are you sure you want to delete this template? Bound campaigns will prevent deletion.")) return;
    try {
      const res = await fetch(`/api/email/templates/${templateId}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error?.message || "Failed to delete template");
        return;
      }
      if (selectedTemplate?.id === templateId) setSelectedTemplate(null);
      loadTemplates();
    } catch {
      // Safe fallback
    }
  }

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Email Templates</h1>
          <p className="text-sm text-zinc-400">
            Immutable versioned templates with schema-validated variable substitution and safe rollback.
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
            + Create Template
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-[300px]">
          <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : templates.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-12 text-center">
          <p className="text-zinc-400">No email templates created yet.</p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="mt-4 px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
          >
            Create Your First Template
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((tpl) => {
            const activeVer = tpl.activeVersion || tpl.versions[0];
            return (
              <div
                key={tpl.id}
                className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 flex flex-col justify-between hover:border-zinc-700 transition"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs px-2 py-0.5 rounded font-medium bg-zinc-800 text-zinc-300 border border-zinc-700">
                      {tpl.type}
                    </span>
                    <span className="text-xs text-sky-400 font-mono">
                      v{activeVer?.version || 1} active ({tpl.versions?.length || 1} versions)
                    </span>
                  </div>
                  <h3 className="text-base font-semibold text-white mt-2">{tpl.name}</h3>
                  <p className="text-xs text-zinc-400 mt-1 line-clamp-1">
                    Subject: {activeVer?.subject || "No subject"}
                  </p>
                  {tpl.description && (
                    <p className="text-xs text-zinc-500 mt-1 line-clamp-2">{tpl.description}</p>
                  )}
                </div>

                <div className="mt-5 pt-4 border-t border-zinc-800 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => openInspector(tpl, "preview")}
                      className="text-xs text-sky-400 hover:text-sky-300 font-medium transition"
                    >
                      Inspect & Preview
                    </button>
                    <span className="text-zinc-600">|</span>
                    <button
                      onClick={() => openInspector(tpl, "test_send")}
                      className="text-xs text-zinc-300 hover:text-white transition"
                    >
                      Test Send
                    </button>
                  </div>
                  <button
                    onClick={() => handleDeleteTemplate(tpl.id)}
                    className="text-xs text-rose-400 hover:text-rose-300 transition"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Template Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-lg w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-bold text-white">Create Email Template</h2>
            {createError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs">
                {createError}
              </div>
            )}
            <form onSubmit={handleCreateTemplate} className="space-y-3">
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Template Name</label>
                <input
                  type="text"
                  required
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="e.g. Welcome Series Onboarding"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Template Type</label>
                  <select
                    value={createType}
                    onChange={(e) => setCreateType(e.target.value as "PROMOTIONAL" | "TRANSACTIONAL")}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  >
                    <option value="PROMOTIONAL">PROMOTIONAL</option>
                    <option value="TRANSACTIONAL">TRANSACTIONAL</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Description (Optional)</label>
                  <input
                    type="text"
                    value={createDescription}
                    onChange={(e) => setCreateDescription(e.target.value)}
                    placeholder="Brief description"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Initial Email Subject (v1)</label>
                <input
                  type="text"
                  required
                  value={createSubject}
                  onChange={(e) => setCreateSubject(e.target.value)}
                  placeholder="Hi {{firstName}}, welcome aboard!"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-400 block mb-1">HTML Content</label>
                <textarea
                  required
                  rows={5}
                  value={createHtmlContent}
                  onChange={(e) => setCreateHtmlContent(e.target.value)}
                  placeholder="<div style='font-family: sans-serif;'><p>Hello {{firstName}},</p><p>Welcome to our platform!</p></div>"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Plain Text Fallback (Optional)</label>
                <textarea
                  rows={2}
                  value={createTextContent}
                  onChange={(e) => setCreateTextContent(e.target.value)}
                  placeholder="Hello {{firstName}}, welcome to our platform!"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-sky-500"
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
                  {creating ? "Creating..." : "Create Template"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Comprehensive Template Inspector & Versioning Modal */}
      {selectedTemplate && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-3xl w-full p-6 space-y-4 max-h-[90vh] flex flex-col">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3 shrink-0">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-white">{selectedTemplate.name}</h2>
                  <span className="text-xs px-2 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                    {selectedTemplate.type}
                  </span>
                </div>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Active Version: v{selectedTemplate.activeVersion?.version || 1} | ID: {selectedTemplate.id}
                </p>
              </div>
              <button
                onClick={() => setSelectedTemplate(null)}
                className="text-zinc-500 hover:text-white"
              >
                ✕
              </button>
            </div>

            {/* Inspector Navigation Tabs */}
            <div className="flex items-center gap-2 border-b border-zinc-800 pb-2 text-xs shrink-0">
              <button
                onClick={() => setInspectorTab("preview")}
                className={`px-3 py-1.5 rounded-lg transition font-medium ${
                  inspectorTab === "preview"
                    ? "bg-sky-600 text-white"
                    : "bg-zinc-800 text-zinc-300 hover:text-white"
                }`}
              >
                Inspect & Preview
              </button>
              <button
                onClick={() => setInspectorTab("versions")}
                className={`px-3 py-1.5 rounded-lg transition font-medium ${
                  inspectorTab === "versions"
                    ? "bg-sky-600 text-white"
                    : "bg-zinc-800 text-zinc-300 hover:text-white"
                }`}
              >
                Version History ({selectedTemplate.versions.length})
              </button>
              <button
                onClick={() => setInspectorTab("new_version")}
                className={`px-3 py-1.5 rounded-lg transition font-medium ${
                  inspectorTab === "new_version"
                    ? "bg-sky-600 text-white"
                    : "bg-zinc-800 text-zinc-300 hover:text-white"
                }`}
              >
                + New Version
              </button>
              <button
                onClick={() => setInspectorTab("metadata")}
                className={`px-3 py-1.5 rounded-lg transition font-medium ${
                  inspectorTab === "metadata"
                    ? "bg-sky-600 text-white"
                    : "bg-zinc-800 text-zinc-300 hover:text-white"
                }`}
              >
                Edit Metadata
              </button>
              <button
                onClick={() => setInspectorTab("test_send")}
                className={`px-3 py-1.5 rounded-lg transition font-medium ${
                  inspectorTab === "test_send"
                    ? "bg-sky-600 text-white"
                    : "bg-zinc-800 text-zinc-300 hover:text-white"
                }`}
              >
                Test Send
              </button>
            </div>

            {/* Tab 1: Preview Active or Inspected Version */}
            {inspectorTab === "preview" && inspectedVersion && (
              <div className="space-y-3 overflow-y-auto flex-1">
                <div className="flex items-center justify-between text-xs bg-zinc-950 p-2.5 rounded-lg border border-zinc-800">
                  <div>
                    <span className="text-zinc-400">Inspecting Version: </span>
                    <span className="text-white font-semibold">v{inspectedVersion.version}</span>
                    {inspectedVersion.id === selectedTemplate.activeVersionId && (
                      <span className="ml-2 text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                        Current Active Version
                      </span>
                    )}
                  </div>
                  {inspectedVersion.id !== selectedTemplate.activeVersionId && (
                    <button
                      onClick={() => handleSetActiveVersion(inspectedVersion.id)}
                      className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-medium transition"
                    >
                      Safe Activate v{inspectedVersion.version}
                    </button>
                  )}
                </div>

                <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800 text-xs">
                  <p className="text-zinc-400">
                    <strong className="text-white">Subject:</strong> {inspectedVersion.subject}
                  </p>
                  {inspectedVersion.textContent && (
                    <p className="text-zinc-400 mt-1">
                      <strong className="text-white">Plain Text:</strong> {inspectedVersion.textContent}
                    </p>
                  )}
                </div>

                <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 min-h-[250px] overflow-y-auto">
                  <div
                    dangerouslySetInnerHTML={{
                      __html: inspectedVersion.htmlContent || "<p>Empty HTML</p>",
                    }}
                    className="text-zinc-300 text-sm prose prose-invert max-w-none"
                  />
                </div>
              </div>
            )}

            {/* Tab 2: Version History */}
            {inspectorTab === "versions" && (
              <div className="space-y-3 overflow-y-auto flex-1">
                <p className="text-xs text-zinc-400">
                  All versions are permanently immutable. Campaigns bind to exact version snapshots at dispatch time.
                </p>
                <div className="space-y-2">
                  {selectedTemplate.versions.map((ver) => {
                    const isActive = ver.id === selectedTemplate.activeVersionId;
                    return (
                      <div
                        key={ver.id}
                        className={`p-3 rounded-lg border flex items-center justify-between transition ${
                          isActive
                            ? "bg-sky-950/20 border-sky-800/80"
                            : "bg-zinc-950 border-zinc-800"
                        }`}
                      >
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-white text-sm">v{ver.version}</span>
                            {isActive ? (
                              <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                                Active
                              </span>
                            ) : (
                              <span className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">
                                Historical
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-zinc-300">Subject: {ver.subject}</p>
                          <p className="text-[11px] text-zinc-500">
                            Created: {new Date(ver.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => {
                              setInspectedVersion(ver);
                              setInspectorTab("preview");
                            }}
                            className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded text-xs transition"
                          >
                            Inspect
                          </button>
                          {!isActive && (
                            <button
                              onClick={() => handleSetActiveVersion(ver.id)}
                              className="px-2.5 py-1 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 rounded text-xs font-medium transition"
                            >
                              Activate
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Tab 3: Create New Version */}
            {inspectorTab === "new_version" && (
              <form onSubmit={handleCreateVersion} className="space-y-3 overflow-y-auto flex-1">
                <p className="text-xs text-zinc-400">
                  Creating a new version preserves older versions unchanged. The new version will automatically become active.
                </p>

                {versionMsg && (
                  <div
                    className={`p-3 rounded-lg text-xs border ${
                      versionMsg.error
                        ? "bg-rose-500/10 border-rose-500/20 text-rose-400"
                        : "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                    }`}
                  >
                    {versionMsg.text}
                  </div>
                )}

                <div>
                  <label className="text-xs text-zinc-400 block mb-1">New Version Subject</label>
                  <input
                    type="text"
                    required
                    value={newVersionSubject}
                    onChange={(e) => setNewVersionSubject(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">HTML Content</label>
                  <textarea
                    required
                    rows={6}
                    value={newVersionHtml}
                    onChange={(e) => setNewVersionHtml(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Plain Text Fallback (Optional)</label>
                  <textarea
                    rows={2}
                    value={newVersionText}
                    onChange={(e) => setNewVersionText(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div className="flex justify-end pt-2">
                  <button
                    type="submit"
                    disabled={creatingVersion}
                    className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                  >
                    {creatingVersion ? "Publishing Version..." : "Publish & Activate New Version"}
                  </button>
                </div>
              </form>
            )}

            {/* Tab 4: Edit Metadata */}
            {inspectorTab === "metadata" && (
              <form onSubmit={handleUpdateMetadata} className="space-y-3 overflow-y-auto flex-1">
                <p className="text-xs text-zinc-400">
                  Update template name, type, and internal description. Requires ADMIN role.
                </p>

                {metadataMsg && (
                  <div
                    className={`p-3 rounded-lg text-xs border ${
                      metadataMsg.error
                        ? "bg-rose-500/10 border-rose-500/20 text-rose-400"
                        : "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                    }`}
                  >
                    {metadataMsg.text}
                  </div>
                )}

                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Template Name</label>
                  <input
                    type="text"
                    required
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Template Type</label>
                  <select
                    value={editType}
                    onChange={(e) => setEditType(e.target.value as "PROMOTIONAL" | "TRANSACTIONAL")}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  >
                    <option value="PROMOTIONAL">PROMOTIONAL</option>
                    <option value="TRANSACTIONAL">TRANSACTIONAL</option>
                  </select>
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
                <div className="flex justify-end pt-2">
                  <button
                    type="submit"
                    disabled={updatingMetadata}
                    className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                  >
                    {updatingMetadata ? "Saving..." : "Save Metadata"}
                  </button>
                </div>
              </form>
            )}

            {/* Tab 5: Test Send */}
            {inspectorTab === "test_send" && (
              <form onSubmit={handleSendTest} className="space-y-4 overflow-y-auto flex-1">
                <p className="text-xs text-zinc-400">
                  Sends a real test email using the currently inspected template version (v{inspectedVersion?.version || 1}) through your configured email provider. Does not create campaign recipient snapshots.
                </p>

                {testSendResult && (
                  <div
                    className={`p-3 rounded-lg text-xs border ${
                      testSendResult.error
                        ? "bg-rose-500/10 border-rose-500/20 text-rose-400"
                        : "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                    }`}
                  >
                    {testSendResult.text}
                  </div>
                )}

                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Test Recipient Email Address</label>
                  <input
                    type="email"
                    required
                    placeholder="developer@example.com"
                    value={testSendEmail}
                    onChange={(e) => setTestSendEmail(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    type="submit"
                    disabled={testSendLoading}
                    className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                  >
                    {testSendLoading ? "Dispatching Test..." : "Send Real Test Email"}
                  </button>
                </div>
              </form>
            )}

            {/* Footer */}
            <div className="flex justify-end pt-3 border-t border-zinc-800 shrink-0">
              <button
                onClick={() => setSelectedTemplate(null)}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition"
              >
                Close Inspector
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
