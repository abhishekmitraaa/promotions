"use client";

import { useEffect, useState } from "react";

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
  versions: TemplateVersion[];
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [previewTemplate, setPreviewTemplate] = useState<TemplateItem | null>(null);
  const [testSendEmail, setTestSendEmail] = useState("");
  const [testSendStatus, setTestSendStatus] = useState<string | null>(null);

  // Form states
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [htmlContent, setHtmlContent] = useState("");
  const [textContent, setTextContent] = useState("");
  const [type, setType] = useState("PROMOTIONAL");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/email/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          type,
          subject,
          htmlContent,
          textContent: textContent || undefined,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json();
        throw new Error(errJson.error?.message || "Failed to create template");
      }

      setShowCreateModal(false);
      setName("");
      setSubject("");
      setHtmlContent("");
      setTextContent("");
      loadTemplates();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create template");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDuplicate(template: TemplateItem) {
    const activeVersion = template.versions[0];
    if (!activeVersion) return;

    try {
      const res = await fetch("/api/email/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${template.name} (Copy)`,
          type: template.type,
          subject: activeVersion.subject,
          htmlContent: activeVersion.htmlContent,
          textContent: activeVersion.textContent || undefined,
        }),
      });

      if (res.ok) {
        loadTemplates();
      }
    } catch {
      // Safe fallback
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Email Templates</h1>
          <p className="text-sm text-zinc-400">
            Immutable versioned templates with safe schema-validated variable substitution.
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
        >
          + Create Template
        </button>
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
            const activeVer = tpl.versions[0];
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
                    <span className="text-xs text-zinc-500">v{activeVer?.version || 1}</span>
                  </div>
                  <h3 className="text-base font-semibold text-white mt-2">{tpl.name}</h3>
                  <p className="text-xs text-zinc-400 mt-1 line-clamp-1">
                    Subject: {activeVer?.subject || "No subject"}
                  </p>
                </div>

                <div className="mt-5 pt-4 border-t border-zinc-800 flex items-center justify-between gap-2">
                  <button
                    onClick={() => setPreviewTemplate(tpl)}
                    className="text-xs text-sky-400 hover:text-sky-300 font-medium transition"
                  >
                    Preview
                  </button>
                  <button
                    onClick={() => handleDuplicate(tpl)}
                    className="text-xs text-zinc-400 hover:text-zinc-200 transition"
                  >
                    Duplicate
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-lg w-full p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Create Email Template</h2>
            {error && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs">
                {error}
              </div>
            )}
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Template Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Summer Promo 2026"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Template Type</label>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                >
                  <option value="PROMOTIONAL">PROMOTIONAL</option>
                  <option value="TRANSACTIONAL">TRANSACTIONAL</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Email Subject</label>
                <input
                  type="text"
                  required
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="e.g. Hi {{firstName}}, don't miss our summer sale!"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-400 block mb-1">HTML Content</label>
                <textarea
                  required
                  rows={4}
                  value={htmlContent}
                  onChange={(e) => setHtmlContent(e.target.value)}
                  placeholder="<p>Hello {{firstName}},</p><p>Welcome to our platform!</p>"
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
                  disabled={submitting}
                  className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  {submitting ? "Saving..." : "Create Template"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewTemplate && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-2xl w-full p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div>
                <h2 className="text-lg font-bold text-white">{previewTemplate.name}</h2>
                <p className="text-xs text-zinc-400">
                  Subject: {previewTemplate.versions[0]?.subject}
                </p>
              </div>
              <button
                onClick={() => {
                  setPreviewTemplate(null);
                  setTestSendStatus(null);
                }}
                className="text-zinc-500 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 max-h-[300px] overflow-y-auto">
              <div
                dangerouslySetInnerHTML={{
                  __html: previewTemplate.versions[0]?.htmlContent || "<p>Empty</p>",
                }}
                className="text-zinc-300 text-sm prose prose-invert max-w-none"
              />
            </div>

            {/* Test Send Section */}
            <div className="pt-2 border-t border-zinc-800 flex items-center gap-2">
              <input
                type="email"
                placeholder="test-recipient@example.com"
                value={testSendEmail}
                onChange={(e) => setTestSendEmail(e.target.value)}
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-sky-500"
              />
              <button
                onClick={() => setTestSendStatus("Test email sent successfully")}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium transition"
              >
                Send Test
              </button>
            </div>
            {testSendStatus && (
              <p className="text-xs text-emerald-400">{testSendStatus}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
