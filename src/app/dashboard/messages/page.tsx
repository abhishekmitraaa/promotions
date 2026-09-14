"use client";

import { useEffect, useState } from "react";

interface MessageItem {
  id: string;
  providerMessageId?: string | null;
  direction: "INBOUND" | "OUTBOUND";
  type: string;
  status: string;
  from: string;
  to: string;
  body?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  sentAt?: string | null;
  deliveredAt?: string | null;
  readAt?: string | null;
}

export default function DashboardMessagesPage() {
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [direction, setDirection] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");

  // Send Modal state
  const [showSendModal, setShowSendModal] = useState(false);
  const [sendType, setSendType] = useState<"text" | "template">("text");
  const [sendTo, setSendTo] = useState("");
  const [sendBody, setSendBody] = useState("");
  const [sendTemplateName, setSendTemplateName] = useState("hello_world");
  const [sendTemplateLanguage, setSendTemplateLanguage] = useState("en_US");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ success: boolean; msg: string } | null>(null);

  useEffect(() => {
    fetchMessages();
  }, [direction, status]);

  async function fetchMessages() {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (direction) params.set("direction", direction);
      if (status) params.set("status", status);
      if (search) params.set("search", search);

      const res = await fetch(`/api/admin/messages?${params.toString()}`);

      const json = await res.json();
      if (json.success) {
        setMessages(json.data);
      }
    } catch (err) {
      console.error("Failed to fetch messages:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setSendResult(null);

    try {
      // First ensure we have a valid key or invoke admin send
      const payload = {
        to: sendTo,
        type: sendType,
        ...(sendType === "text" ? { body: sendBody } : { templateName: sendTemplateName, templateLanguage: sendTemplateLanguage }),
      };

      const res = await fetch("/api/admin/messages/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const json = await res.json();

      if (res.ok && json.success) {
        setSendResult({
          success: true,
          msg: `Message queued successfully! Provider ID: ${json.message.providerMessageId || "Simulated"}`,
        });
        fetchMessages();
        setTimeout(() => {
          setShowSendModal(false);
          setSendTo("");
          setSendBody("");
        }, 1500);
      } else {
        setSendResult({
          success: false,
          msg: json.error?.message || "Failed to dispatch WhatsApp message.",
        });
      }
    } catch (err) {
      setSendResult({
        success: false,
        msg: err instanceof Error ? err.message : "Error sending message",
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Message History & Dispatch</h2>
          <p className="text-zinc-400 text-sm">View log history and manually dispatch WhatsApp messages.</p>
        </div>

        <button
          onClick={() => setShowSendModal(true)}
          className="px-4 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold rounded-xl text-sm transition shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
        >
          <span>➕</span> Dispatch Message
        </button>
      </div>

      {/* Filter Bar */}
      <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-400 font-medium">Direction:</label>
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-emerald-500"
          >
            <option value="">All Directions</option>
            <option value="OUTBOUND">Outbound</option>
            <option value="INBOUND">Inbound</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-400 font-medium">Status:</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-emerald-500"
          >
            <option value="">All Statuses</option>
            <option value="QUEUED">QUEUED</option>
            <option value="SENT">SENT</option>
            <option value="DELIVERED">DELIVERED</option>
            <option value="READ">READ</option>
            <option value="FAILED">FAILED</option>
            <option value="RECEIVED">RECEIVED</option>
          </select>
        </div>

        <div className="flex-1 min-w-[200px]">
          <input
            type="text"
            placeholder="Search by phone number or ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchMessages()}
            className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-3 py-1.5 placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
          />
        </div>

        <button
          onClick={fetchMessages}
          className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg border border-zinc-700 transition"
        >
          Refresh
        </button>
      </div>

      {/* Messages Data Table */}
      <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-zinc-300">
            <thead className="bg-zinc-900/80 text-xs uppercase text-zinc-400 font-semibold border-b border-zinc-800">
              <tr>
                <th className="px-5 py-3">Direction</th>
                <th className="px-5 py-3">Type</th>
                <th className="px-5 py-3">Recipient / Sender</th>
                <th className="px-5 py-3">Message Content</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Provider ID</th>
                <th className="px-5 py-3">Created At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {loading ? (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-zinc-500">
                    Loading messages...
                  </td>
                </tr>
              ) : messages.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-zinc-500">
                    No messages found matching your criteria.
                  </td>
                </tr>
              ) : (
                messages.map((msg) => (
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
                      {msg.type === "TEMPLATE"
                        ? `Template: ${msg.templateName} (${msg.templateLanguage || "en_US"})`
                        : msg.body || "[No Text Body]"}
                      {msg.errorMessage && (
                        <div className="text-xs text-rose-400 mt-1 truncate">Err: {msg.errorMessage}</div>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`text-xs px-2 py-0.5 rounded font-medium ${
                          msg.status === "FAILED"
                            ? "bg-rose-950 text-rose-400 border border-rose-800"
                            : msg.status === "READ"
                            ? "bg-sky-950 text-sky-400 border border-sky-800"
                            : msg.status === "DELIVERED" || msg.status === "SENT"
                            ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                            : "bg-zinc-800 text-zinc-300"
                        }`}
                      >
                        {msg.status}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-zinc-500 max-w-[120px] truncate">
                      {msg.providerMessageId || "—"}
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

      {/* Send Message Modal */}
      {showSendModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden p-6 space-y-5">
            <div className="flex justify-between items-center border-b border-zinc-800 pb-4">
              <h3 className="text-lg font-bold text-white">Send WhatsApp Message</h3>
              <button
                onClick={() => setShowSendModal(false)}
                className="text-zinc-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSendMessage} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-400 uppercase mb-1">
                  Recipient Phone Number (E.164 without +)
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. 919876543210"
                  value={sendTo}
                  onChange={(e) => setSendTo(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 uppercase mb-1">
                  Message Type
                </label>
                <select
                  value={sendType}
                  onChange={(e) => setSendType(e.target.value as "text" | "template")}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                >
                  <option value="text">Text Message</option>
                  <option value="template">Template Message</option>
                </select>
              </div>

              {sendType === "text" ? (
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase mb-1">
                    Text Body
                  </label>
                  <textarea
                    required
                    rows={4}
                    placeholder="Enter your message content..."
                    value={sendBody}
                    onChange={(e) => setSendBody(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 uppercase mb-1">
                      Template Name
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. hello_world"
                      value={sendTemplateName}
                      onChange={(e) => setSendTemplateName(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 uppercase mb-1">
                      Language Code
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="en_US"
                      value={sendTemplateLanguage}
                      onChange={(e) => setSendTemplateLanguage(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono"
                    />
                  </div>
                </div>
              )}

              {sendResult && (
                <div
                  className={`p-3 rounded-xl text-xs ${
                    sendResult.success
                      ? "bg-emerald-950/80 border border-emerald-800 text-emerald-300"
                      : "bg-rose-950/80 border border-rose-800 text-rose-300"
                  }`}
                >
                  {sendResult.msg}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setShowSendModal(false)}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-sm transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sending}
                  className="px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold rounded-xl text-sm transition shadow-lg shadow-emerald-500/20"
                >
                  {sending ? "Sending..." : "Dispatch Now"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
