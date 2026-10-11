"use client";

import { useState, useTransition } from "react";
import { generateDailySummaryNarrativeAction } from "@/actions";

export function DailySummaryAiPanel({ branchCode, date }: { branchCode: string; date: string }) {
  const [narrative, setNarrative] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function generate() {
    setError(null);
    startTransition(async () => {
      const res = await generateDailySummaryNarrativeAction(branchCode, date);
      if (!res.ok) {
        setError(res.error);
        setNarrative(null);
        return;
      }
      setNarrative(res.narrative);
    });
  }

  return (
    <div className="panel p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="font-semibold">AI overview</h2>
        <button type="button" className="btn-secondary" disabled={pending} onClick={generate}>
          {pending ? "Generating…" : error ? "Retry" : narrative ? "Regenerate" : "Generate AI overview"}
        </button>
      </div>
      <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
        Written by Gemini from the exact numbers below — it narrates them, it doesn&apos;t compute anything on its
        own. Treat it as a first read, not a substitute for the figures.
      </p>
      {error && (
        <p className="text-sm" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
      {narrative && (
        <p className="whitespace-pre-line text-sm" style={{ lineHeight: 1.6 }}>
          {narrative}
        </p>
      )}
      {!narrative && !error && !pending && (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Not generated yet for this day.
        </p>
      )}
    </div>
  );
}
