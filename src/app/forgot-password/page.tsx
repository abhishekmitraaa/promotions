"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setMessage("");

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message || "Failed to process request");
      } else {
        setMessage(
          data.message ||
            "If an account with that email exists, password reset instructions have been sent."
        );
      }
    } catch {
      setError("An unexpected network error occurred.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6 bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
        <div>
          <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">
            Security & Recovery
          </span>
          <h1 className="text-2xl font-bold mt-1">Forgot Password</h1>
          <p className="text-zinc-400 text-sm mt-1">
            Enter your account email to receive reset instructions.
          </p>
        </div>

        {message ? (
          <div className="space-y-4">
            <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm leading-relaxed">
              {message}
            </div>
            <p className="text-xs text-zinc-400">
              Please check your inbox and spam folder. The reset link is valid for 15 minutes.
            </p>
            <div className="pt-2">
              <Link
                href="/login"
                className="block text-center w-full rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium p-3 text-sm transition"
              >
                Back to Sign in
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <label className="block text-sm">
              Email Address
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@example.com"
                className="mt-2 w-full rounded-lg bg-zinc-950 border border-zinc-700 p-3 text-sm focus:outline-none focus:border-emerald-500"
              />
            </label>

            {error && <div className="text-sm text-rose-400">{error}</div>}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold p-3 text-sm transition disabled:opacity-50"
            >
              {loading ? "Sending instructions…" : "Send Reset Link"}
            </button>

            <div className="text-center pt-1">
              <Link
                href="/login"
                className="text-xs text-zinc-400 hover:text-zinc-200 transition"
              >
                Remember your password? Sign in
              </Link>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
