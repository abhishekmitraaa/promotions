"use client";

import { FormEvent, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isVerified = searchParams.get("verified") === "true";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message || "Login failed");
      } else {
        router.replace("/dashboard");
      }
    } catch {
      setError("An unexpected network error occurred.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-md space-y-6 bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
      <div>
        <h1 className="text-2xl font-bold">WhatsApp Infrastructure</h1>
        <p className="text-zinc-400 text-sm mt-1">Sign in to the administration dashboard</p>
      </div>

      {isVerified && (
        <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm">
          Your email address has been verified! Please sign in.
        </div>
      )}

      <label className="block text-sm">
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-2 w-full rounded-lg bg-zinc-950 border border-zinc-700 p-3 text-sm focus:outline-none focus:border-emerald-500"
        />
      </label>

      <div>
        <div className="flex items-center justify-between text-sm">
          <label htmlFor="login-password">Password</label>
          <Link
            href="/forgot-password"
            className="text-xs text-emerald-400 hover:text-emerald-300 transition"
          >
            Forgot password?
          </Link>
        </div>
        <input
          id="login-password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-2 w-full rounded-lg bg-zinc-950 border border-zinc-700 p-3 text-sm focus:outline-none focus:border-emerald-500"
        />
      </div>

      {error && <div className="text-sm text-rose-400">{error}</div>}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold p-3 text-sm transition disabled:opacity-50"
      >
        {loading ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <Suspense fallback={<div className="text-zinc-400 text-sm">Loading…</div>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
