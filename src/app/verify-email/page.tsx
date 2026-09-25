"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";

  const [loading, setLoading] = useState(true);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setError("No verification token was provided in the link.");
      setLoading(false);
      return;
    }

    async function verify() {
      try {
        const res = await fetch("/api/auth/verify-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });

        const data = await res.json();
        if (!res.ok) {
          setError(data.error?.message || "Email verification failed or link has expired.");
        } else {
          setSuccess(true);
        }
      } catch {
        setError("Network error occurred during email verification.");
      } finally {
        setLoading(false);
      }
    }

    verify();
  }, [token]);

  return (
    <div className="w-full max-w-md space-y-6 bg-zinc-900 border border-zinc-800 rounded-2xl p-8 text-center">
      <div>
        <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">
          Email Verification
        </span>
        <h1 className="text-2xl font-bold mt-1">Account Confirmation</h1>
      </div>

      {loading ? (
        <div className="py-6 space-y-3">
          <div className="inline-block w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-sm text-zinc-400">Verifying your email token…</p>
        </div>
      ) : success ? (
        <div className="space-y-5">
          <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm leading-relaxed">
            Your email address has been successfully verified!
          </div>
          <Link
            href="/login?verified=true"
            className="block w-full rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold p-3 text-sm transition"
          >
            Continue to Sign in
          </Link>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-sm leading-relaxed">
            {error}
          </div>
          <p className="text-xs text-zinc-400">
            If your verification link has expired, you can request a new verification link after signing in.
          </p>
          <Link
            href="/login"
            className="block w-full rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium p-3 text-sm transition"
          >
            Return to Sign in
          </Link>
        </div>
      )}
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <Suspense fallback={<div className="text-zinc-400 text-sm">Verifying…</div>}>
        <VerifyEmailContent />
      </Suspense>
    </main>
  );
}
