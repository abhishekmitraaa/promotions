"use client";

import { FormEvent, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tokenFromUrl = searchParams.get("token") || "";

  const [token, setToken] = useState(tokenFromUrl);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (!token.trim()) {
      setError("Reset token is required.");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters long.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim(), password }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message || "Failed to reset password.");
      } else {
        setSuccess(true);
        setTimeout(() => {
          router.replace("/login");
        }, 3000);
      }
    } catch {
      setError("An unexpected network error occurred.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md space-y-6 bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
      <div>
        <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">
          Account Security
        </span>
        <h1 className="text-2xl font-bold mt-1">Reset Password</h1>
        <p className="text-zinc-400 text-sm mt-1">
          Enter and confirm your new account password.
        </p>
      </div>

      {success ? (
        <div className="space-y-4">
          <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm leading-relaxed">
            Password has been successfully reset! All existing sessions have been invalidated. Redirecting to login…
          </div>
          <Link
            href="/login"
            className="block text-center w-full rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold p-3 text-sm transition"
          >
            Sign in now
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          {!tokenFromUrl && (
            <label className="block text-sm">
              Reset Token
              <input
                type="text"
                required
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste reset token from email"
                className="mt-2 w-full rounded-lg bg-zinc-950 border border-zinc-700 p-3 text-sm focus:outline-none focus:border-emerald-500"
              />
            </label>
          )}

          <label className="block text-sm">
            New Password (minimum 8 characters)
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="mt-2 w-full rounded-lg bg-zinc-950 border border-zinc-700 p-3 text-sm focus:outline-none focus:border-emerald-500"
            />
          </label>

          <label className="block text-sm">
            Confirm New Password
            <input
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              className="mt-2 w-full rounded-lg bg-zinc-950 border border-zinc-700 p-3 text-sm focus:outline-none focus:border-emerald-500"
            />
          </label>

          {error && <div className="text-sm text-rose-400">{error}</div>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold p-3 text-sm transition disabled:opacity-50"
          >
            {loading ? "Resetting password…" : "Reset Password"}
          </button>

          <div className="text-center pt-1">
            <Link
              href="/login"
              className="text-xs text-zinc-400 hover:text-zinc-200 transition"
            >
              Cancel and return to sign in
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <Suspense fallback={<div className="text-zinc-400 text-sm">Loading…</div>}>
        <ResetPasswordForm />
      </Suspense>
    </main>
  );
}
