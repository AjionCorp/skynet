"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

async function getLoginErrorMessage(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const data = await res.json() as { error?: unknown };
      if (typeof data.error === "string" && data.error.trim().length > 0) {
        return data.error;
      }
    } catch {
      // Fall through to the HTTP-status fallback below.
    }
  } else {
    try {
      const text = (await res.text()).trim();
      if (text.length > 0) {
        return text;
      }
    } catch {
      // Fall through to the HTTP-status fallback below.
    }
  }

  return `Authentication failed (HTTP ${res.status})`;
}

export default function LoginPage() {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });

      if (res.ok) {
        router.push("/admin/pipeline");
      } else {
        setError(await getLoginErrorMessage(res));
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-8"
      >
        <h1 className="text-xl font-semibold text-white">Skynet Admin</h1>
        <p className="text-sm text-zinc-400">Enter your API key to continue.</p>

        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="API key"
          className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
          autoFocus
        />

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={loading || !apiKey}
          className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {loading ? "Authenticating..." : "Log in"}
        </button>
      </form>
    </div>
  );
}
