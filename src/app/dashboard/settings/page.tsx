"use client";

import { useEffect, useState } from "react";

export default function DashboardSettingsPage() {
  const [healthData, setHealthData] = useState<{
    database: string;
    metaCloudApi: string;
  } | null>(null);

  useEffect(() => {
    fetch("/api/admin/overview")
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setHealthData(data.health);
      })
      .catch(console.error);
  }, []);

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight">System Settings & Meta Configuration</h2>
        <p className="text-zinc-400 text-sm">
          Inspect environment variable readiness and Meta WhatsApp Cloud API connectivity without exposing secret values.
        </p>
      </div>

      {/* Environment Config Checklist */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden p-6 space-y-6">
        <h3 className="text-lg font-bold text-white flex items-center gap-2">
          <span>⚙️</span> Meta Developer Portal Credentials Checklist
        </h3>

        <div className="space-y-4 text-sm">
          <div className="p-4 rounded-xl bg-zinc-950/80 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="font-mono text-zinc-200 font-semibold">META_GRAPH_API_VERSION</div>
              <div className="text-xs text-zinc-500">Configured Graph API endpoint version (e.g. v22.0)</div>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-mono bg-zinc-800 text-emerald-400 font-semibold">
              Configured
            </span>
          </div>

          <div className="p-4 rounded-xl bg-zinc-950/80 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="font-mono text-zinc-200 font-semibold">META_ACCESS_TOKEN</div>
              <div className="text-xs text-zinc-500">System User Permanent Access Token with whatsapp_business_messaging scope</div>
            </div>
            <span
              className={`px-3 py-1 rounded-full text-xs font-mono font-semibold ${
                healthData?.metaCloudApi === "configured"
                  ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                  : "bg-amber-950 text-amber-400 border border-amber-800"
              }`}
            >
              {healthData?.metaCloudApi === "configured" ? "Configured" : "Dev Simulation / Unconfigured"}
            </span>
          </div>

          <div className="p-4 rounded-xl bg-zinc-950/80 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="font-mono text-zinc-200 font-semibold">META_PHONE_NUMBER_ID</div>
              <div className="text-xs text-zinc-500">Unique Phone Number ID from Meta WhatsApp Console</div>
            </div>
            <span
              className={`px-3 py-1 rounded-full text-xs font-mono font-semibold ${
                healthData?.metaCloudApi === "configured"
                  ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                  : "bg-amber-950 text-amber-400 border border-amber-800"
              }`}
            >
              {healthData?.metaCloudApi === "configured" ? "Configured" : "Dev Simulation / Unconfigured"}
            </span>
          </div>

          <div className="p-4 rounded-xl bg-zinc-950/80 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="font-mono text-zinc-200 font-semibold">META_APP_SECRET</div>
              <div className="text-xs text-zinc-500">Meta App Secret used for validating X-Hub-Signature-256 on webhooks</div>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-mono bg-zinc-800 text-zinc-300 font-semibold">
              Managed in .env.local
            </span>
          </div>

          <div className="p-4 rounded-xl bg-zinc-950/80 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="font-mono text-zinc-200 font-semibold">META_WEBHOOK_VERIFY_TOKEN</div>
              <div className="text-xs text-zinc-500">Custom secret string used during GET webhook verification challenge</div>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-mono bg-zinc-800 text-zinc-300 font-semibold">
              Managed in .env.local
            </span>
          </div>

          <div className="p-4 rounded-xl bg-zinc-950/80 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="font-mono text-zinc-200 font-semibold">ADMIN_USERNAME &amp; ADMIN_PASSWORD</div>
              <div className="text-xs text-zinc-500">HTTP Basic Auth protection for /dashboard and /api/admin/*</div>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-mono bg-emerald-950 text-emerald-400 border border-emerald-800 font-semibold">
              Active (HTTP Basic Auth)
            </span>
          </div>

          <div className="p-4 rounded-xl bg-zinc-950/80 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="font-mono text-zinc-200 font-semibold">API_KEY_PEPPER</div>
              <div className="text-xs text-zinc-500">Cryptographic secret salt for HMAC-SHA256 API key hashing</div>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-mono bg-zinc-800 text-zinc-300 font-semibold">
              Managed in .env.local
            </span>
          </div>
        </div>
      </div>

      {/* Setup Instructions Card */}
      <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-6 space-y-4 text-sm text-zinc-300">
        <h3 className="text-base font-bold text-white flex items-center gap-2">
          <span>📖</span> How to Connect Your Meta Developer Account
        </h3>

        <ol className="list-decimal list-inside space-y-2.5 text-xs text-zinc-400 leading-relaxed">
          <li>
            Go to <a href="https://developers.facebook.com" target="_blank" className="text-emerald-400 hover:underline">Meta for Developers Console</a> and select your WhatsApp App.
          </li>
          <li>
            Navigate to <strong className="text-zinc-200">WhatsApp &gt; API Setup</strong> to retrieve your <code className="bg-zinc-800 px-1 py-0.5 rounded font-mono text-zinc-300">Phone Number ID</code> and <code className="bg-zinc-800 px-1 py-0.5 rounded font-mono text-zinc-300">Temporary or System Access Token</code>.
          </li>
          <li>
            Paste credentials into <code className="bg-zinc-800 px-1 py-0.5 rounded font-mono text-zinc-300">.env.local</code> in the root directory.
          </li>
          <li>
            Configure Meta Webhooks pointing to <code className="bg-zinc-800 px-1 py-0.5 rounded font-mono text-zinc-300">https://YOUR-PUBLIC-DOMAIN/api/webhooks/whatsapp</code> (or use ngrok for local dev).
          </li>
        </ol>
      </div>
    </div>
  );
}
