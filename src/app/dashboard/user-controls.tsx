"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function UserControls() {
  const router = useRouter();
  const [user, setUser] = useState<{ email: string; role: string } | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setUser(d.data);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="flex items-center gap-3">
      <span className="px-3 py-1.5 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-medium">
        {user ? `${user.email} · ${user.role}` : "Loading…"}
      </span>
      <button
        onClick={async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          router.push("/login");
        }}
        className="text-xs text-zinc-300 hover:text-white px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700"
      >
        Logout
      </button>
    </div>
  );
}