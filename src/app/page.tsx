import Link from "next/link";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center p-6 font-sans">
      <div className="max-w-2xl w-full bg-gradient-to-b from-zinc-900 to-zinc-900/60 border border-zinc-800 rounded-3xl p-10 text-center space-y-8 shadow-2xl">
        <div className="mx-auto w-16 h-16 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 font-extrabold text-3xl shadow-xl shadow-emerald-500/20">
          WA
        </div>

        <div className="space-y-3">
          <h1 className="text-3xl font-extrabold text-white tracking-tight sm:text-4xl">
            WhatsApp Messaging Infrastructure
          </h1>
          <p className="text-zinc-400 text-sm max-w-lg mx-auto leading-relaxed">
            Self-hosted WhatsApp Cloud API service layer featuring REST API, Meta Webhooks receiver, OTP verification, and Dashboard management.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-2">
          <Link
            href="/dashboard"
            className="w-full sm:w-auto px-8 py-3.5 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-2xl transition shadow-xl shadow-emerald-500/25 flex items-center justify-center gap-2 text-sm"
          >
            <span>🚀</span> Open Dashboard
          </Link>
          <a
            href="/api/health"
            target="_blank"
            className="w-full sm:w-auto px-6 py-3.5 bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 font-semibold rounded-2xl border border-zinc-700 transition text-sm"
          >
            Check Health Endpoint ↗
          </a>
        </div>

        <div className="pt-6 border-t border-zinc-800/80 grid grid-cols-3 gap-4 text-xs text-zinc-500 font-mono">
          <div>Next.js 16 App Router</div>
          <div>SQLite & Prisma ORM</div>
          <div>Meta Graph API v22.0</div>
        </div>
      </div>
    </div>
  );
}
