import Link from "next/link";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      {/* Top Navbar */}
      <header className="h-16 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-md px-6 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 font-bold text-lg shadow-lg shadow-emerald-500/10">
            WA
          </div>
          <div>
            <h1 className="font-semibold text-zinc-100 leading-tight">WhatsApp Infrastructure</h1>
            <p className="text-xs text-zinc-400">Meta Cloud API Service Hub</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-950/60 border border-emerald-800/50 text-emerald-400 text-xs font-medium">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Local Service Active
          </div>
          <a
            href="/api/health"
            target="_blank"
            className="text-xs text-zinc-400 hover:text-zinc-200 transition px-2 py-1 rounded bg-zinc-800/60 border border-zinc-700/50"
          >
            Health API ↗
          </a>
        </div>
      </header>

      <div className="flex flex-1">
        {/* Sidebar */}
        <aside className="w-64 border-r border-zinc-800/80 bg-zinc-900/40 p-4 flex flex-col gap-1 hidden md:flex shrink-0">
          <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-3 py-2">
            Navigation
          </div>

          <Link
            href="/dashboard"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60 transition"
          >
            <span className="text-zinc-400">📊</span> Overview
          </Link>

          <Link
            href="/dashboard/messages"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60 transition"
          >
            <span className="text-zinc-400">💬</span> Messages & Dispatch
          </Link>

          <Link
            href="/dashboard/conversations"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60 transition"
          >
            <span className="text-zinc-400">👥</span> Conversations
          </Link>

          <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-3 py-2 mt-4">
            Developer API
          </div>

          <Link
            href="/dashboard/api-keys"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60 transition"
          >
            <span className="text-zinc-400">🔑</span> API Keys
          </Link>

          <Link
            href="/dashboard/webhooks"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60 transition"
          >
            <span className="text-zinc-400">⚡</span> Webhooks & Events
          </Link>

          <Link
            href="/dashboard/settings"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60 transition mt-auto"
          >
            <span className="text-zinc-400">⚙️</span> Meta Configuration
          </Link>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 p-6 lg:p-8 max-w-7xl mx-auto w-full">
          {children}
        </main>
      </div>
    </div>
  );
}
