"use client";

import { useEffect, useState } from "react";

interface ConversationItem {
  phoneNumber: string;
  latestMessage: {
    id: string;
    direction: "INBOUND" | "OUTBOUND";
    body?: string;
    type: string;
    status: string;
    createdAt: string;
  };
  messageCount: number;
  unreadCount: number;
}

export default function DashboardConversationsPage() {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);

  async function fetchConversations() {
    try {
      const res = await fetch("/api/admin/conversations");
      const json = await res.json();
      if (json.success) {
        setConversations(json.data);
        if (json.data.length > 0) {
          setSelectedPhone(json.data[0].phoneNumber);
        }
      }
    } catch (err) {
      console.error("Failed to load conversations:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchConversations();
  }, []);

  const activeConversation = conversations.find((c) => c.phoneNumber === selectedPhone);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight">Conversations & Contacts</h2>
        <p className="text-zinc-400 text-sm">Grouped chat threads by participant phone number.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 h-[600px]">
        {/* Contact List */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-y-auto p-3 flex flex-col gap-2">
          <div className="text-xs font-semibold text-zinc-500 uppercase px-3 py-1">Recent Contacts</div>
          {loading ? (
            <div className="text-center py-8 text-zinc-500 text-sm">Loading conversations...</div>
          ) : conversations.length === 0 ? (
            <div className="text-center py-8 text-zinc-500 text-sm">No active conversations found.</div>
          ) : (
            conversations.map((conv) => (
              <button
                key={conv.phoneNumber}
                onClick={() => setSelectedPhone(conv.phoneNumber)}
                className={`p-3.5 rounded-xl text-left transition flex items-center justify-between ${
                  selectedPhone === conv.phoneNumber
                    ? "bg-emerald-950/80 border border-emerald-800/80 text-white"
                    : "bg-zinc-900/40 hover:bg-zinc-800/60 text-zinc-300 border border-transparent"
                }`}
              >
                <div>
                  <div className="font-mono text-sm font-semibold flex items-center gap-2">
                    📱 +{conv.phoneNumber}
                    {conv.unreadCount > 0 && (
                      <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    )}
                  </div>
                  <div className="text-xs text-zinc-400 truncate max-w-[180px] mt-1">
                    {conv.latestMessage.body || `[${conv.latestMessage.type}]`}
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-[10px] text-zinc-500">
                    {new Date(conv.latestMessage.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono mt-1 inline-block">
                    {conv.messageCount} msgs
                  </span>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Selected Thread View */}
        <div className="md:col-span-2 bg-zinc-900/60 border border-zinc-800 rounded-2xl p-6 flex flex-col justify-between">
          {activeConversation ? (
            <div className="space-y-6 flex-1 flex flex-col justify-between">
              <div className="border-b border-zinc-800 pb-4 flex justify-between items-center">
                <div>
                  <h3 className="text-lg font-bold text-white font-mono">+{activeConversation.phoneNumber}</h3>
                  <p className="text-xs text-zinc-400">Total {activeConversation.messageCount} messages recorded</p>
                </div>
                <span className="px-3 py-1 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800">
                  Active Participant
                </span>
              </div>

              {/* Message Bubble Simulation */}
              <div className="flex-1 space-y-4 overflow-y-auto p-4 bg-zinc-950/60 rounded-xl border border-zinc-800/60 flex flex-col justify-end">
                <div
                  className={`p-3.5 rounded-2xl max-w-md ${
                    activeConversation.latestMessage.direction === "OUTBOUND"
                      ? "bg-emerald-950/90 border border-emerald-800 text-emerald-100 self-end"
                      : "bg-zinc-800 text-zinc-100 self-start"
                  }`}
                >
                  <div className="text-xs font-semibold text-zinc-400 mb-1">
                    {activeConversation.latestMessage.direction === "OUTBOUND" ? "Outbound Dispatch" : "Inbound WhatsApp"}
                  </div>
                  <div className="text-sm">
                    {activeConversation.latestMessage.body || `[${activeConversation.latestMessage.type} Message]`}
                  </div>
                  <div className="text-[10px] text-zinc-400 text-right mt-1.5 font-mono">
                    {new Date(activeConversation.latestMessage.createdAt).toLocaleString()} · {activeConversation.latestMessage.status}
                  </div>
                </div>
              </div>

              <div className="text-xs text-zinc-500 text-center">
                To dispatch a new message to this participant, use the <a href="/dashboard/messages" className="text-emerald-400 hover:underline">Messages & Dispatch</a> panel.
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-zinc-500 text-sm">
              <span>💬</span> Select a contact thread from the list to inspect conversation history.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
