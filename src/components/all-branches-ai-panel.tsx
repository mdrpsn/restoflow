"use client";

import { useState } from "react";
import { generateDailySummaryNarrativeAction } from "@/actions";

type BranchRow = { code: string; name: string; transactions: number };

type Status = { state: "idle" | "pending" | "done" | "error"; narrative?: string; error?: string };

export function AllBranchesAiPanel({ branches, date }: { branches: BranchRow[]; date: string }) {
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [runningAll, setRunningAll] = useState(false);

  const active = branches.filter((b) => b.transactions > 0);
  const quiet = branches.filter((b) => b.transactions === 0);

  async function generateOne(code: string) {
    setStatuses((s) => ({ ...s, [code]: { state: "pending" } }));
    const res = await generateDailySummaryNarrativeAction(code, date);
    setStatuses((s) => ({
      ...s,
      [code]: res.ok ? { state: "done", narrative: res.narrative } : { state: "error", error: res.error },
    }));
  }

  async function generateAll() {
    setRunningAll(true);
    await Promise.all(active.map((b) => generateOne(b.code)));
    setRunningAll(false);
  }

  const anyDone = Object.values(statuses).some((s) => s.state !== "idle");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {active.length === branches.length
            ? "One click generates every branch's AI overview at once, instead of switching branches one at a time."
            : `${quiet.length} branch${quiet.length === 1 ? "" : "es"} had no sales today, so ${quiet.length === 1 ? "it's" : "they're"} skipped below to save the day's AI quota.`}
        </p>
        {active.length > 0 && (
          <button type="button" className="btn-primary shrink-0" disabled={runningAll} onClick={generateAll}>
            {runningAll ? "Generating…" : anyDone ? "Regenerate all" : "Generate all AI overviews"}
          </button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {active.map((b) => {
          const status = statuses[b.code] ?? { state: "idle" as const };
          const label =
            status.state === "pending" ? "…" : status.state === "error" ? "Retry" : status.state === "idle" ? "Generate" : "Regenerate";
          return (
            <div key={b.code} className="panel p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="font-semibold">
                  {b.name} <span style={{ color: "var(--muted)", fontWeight: 400 }}>({b.code})</span>
                </h3>
                <button
                  type="button"
                  className="btn-secondary px-2 py-1 text-xs"
                  disabled={status.state === "pending"}
                  onClick={() => generateOne(b.code)}
                >
                  {label}
                </button>
              </div>
              {status.state === "idle" && (
                <p className="text-sm" style={{ color: "var(--muted)" }}>
                  Not generated yet.
                </p>
              )}
              {status.state === "pending" && (
                <p className="text-sm" style={{ color: "var(--muted)" }}>
                  Generating…
                </p>
              )}
              {status.state === "error" && (
                <p className="text-sm" style={{ color: "var(--danger)" }}>
                  Couldn&apos;t generate this one: {status.error}
                </p>
              )}
              {status.state === "done" && (
                <p className="whitespace-pre-line text-sm" style={{ lineHeight: 1.6 }}>
                  {status.narrative}
                </p>
              )}
            </div>
          );
        })}

        {quiet.map((b) => (
          <div key={b.code} className="panel p-4">
            <h3 className="mb-2 font-semibold">
              {b.name} <span style={{ color: "var(--muted)", fontWeight: 400 }}>({b.code})</span>
            </h3>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              No sales recorded today.
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
