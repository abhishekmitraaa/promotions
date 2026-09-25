import Link from "next/link";
import UserControls from "./user-controls";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      <header className="h-16 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-md px-6 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-3"><div className="h-9 w-9 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 font-bold text-lg">WA</div><div><h1 className="font-semibold">WhatsApp Infrastructure</h1><p className="text-xs text-zinc-400">Meta Cloud API Service Hub</p></div></div>
        <UserControls />
      </header>
      <div className="flex flex-1">
        <aside className="w-64 border-r border-zinc-800/80 bg-zinc-900/40 p-4 flex flex-col gap-1 hidden md:flex shrink-0 overflow-y-auto">
          <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-3 py-1">Communication</div>
          
          {/* WhatsApp Section */}
          <div className="text-xs font-medium text-emerald-400 px-3 py-1 mt-1 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> WhatsApp
          </div>
          <Link href="/dashboard" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">📊 Overview</Link>
          <Link href="/dashboard/messages" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">💬 Messages & Dispatch</Link>
          <Link href="/dashboard/conversations" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">👥 Conversations</Link>

          {/* Email Section */}
          <div className="text-xs font-medium text-sky-400 px-3 py-1 mt-3 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-sky-500"></span> Email
          </div>
          <Link href="/dashboard/email" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">✉️ Email Dashboard</Link>
          <Link href="/dashboard/email/templates" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">📝 Templates</Link>
          <Link href="/dashboard/email/contacts" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">👤 Contacts</Link>
          <Link href="/dashboard/email/lists" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">📋 Lists</Link>
          <Link href="/dashboard/email/segments" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">🎯 Segments</Link>
          <Link href="/dashboard/email/campaigns" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">🚀 Campaigns</Link>
          <Link href="/dashboard/email/deliveries" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">📬 Deliveries</Link>
          <Link href="/dashboard/email/suppressions" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">🚫 Suppression</Link>
          <Link href="/dashboard/email/providers" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">⚙️ Provider Settings</Link>

          <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-3 py-1 mt-4">Developer & Admin</div>
          <Link href="/dashboard/api-keys" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">🔑 API Keys</Link>
          <Link href="/dashboard/webhooks" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">⚡ Webhooks & Events</Link>
          <Link href="/dashboard/settings" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">⚙️ Meta Configuration</Link>
          <Link href="/dashboard/users" className="px-3 py-1.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60">👤 User Access</Link>
        </aside>
        <main className="flex-1 p-6 lg:p-8 max-w-7xl mx-auto w-full">{children}</main>
      </div>
    </div>
  );
}