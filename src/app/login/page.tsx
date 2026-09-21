"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setLoading(true); setError("");
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    const data = await res.json();
    if (!res.ok) setError(data.error?.message || "Login failed");
    else router.replace("/dashboard");
    setLoading(false);
  }
  return <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6"><form onSubmit={submit} className="w-full max-w-md space-y-6 bg-zinc-900 border border-zinc-800 rounded-2xl p-8"><div><h1 className="text-2xl font-bold">WhatsApp Infrastructure</h1><p className="text-zinc-400 text-sm mt-1">Sign in to the administration dashboard</p></div><label className="block text-sm">Email<input type="email" required value={email} onChange={e=>setEmail(e.target.value)} className="mt-2 w-full rounded-lg bg-zinc-950 border border-zinc-700 p-3"/></label><label className="block text-sm">Password<input type="password" required value={password} onChange={e=>setPassword(e.target.value)} className="mt-2 w-full rounded-lg bg-zinc-950 border border-zinc-700 p-3"/></label>{error&&<div className="text-sm text-rose-400">{error}</div>}<button disabled={loading} className="w-full rounded-lg bg-emerald-500 text-zinc-950 font-semibold p-3 disabled:opacity-50">{loading?"Signing in…":"Sign in"}</button></form></main>;
}
