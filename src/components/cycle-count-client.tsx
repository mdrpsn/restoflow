"use client";

import { useMemo, useState, useTransition } from "react";
import { runCycleCountAction } from "@/actions";
import { confirmed } from "@/lib/confirm";

type Ingredient = { id: string; name: string; unit: string; onHand: string };

export function CycleCountClient({ ingredients }: { ingredients: Ingredient[] }) {
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const changedCount = useMemo(
    () =>
      ingredients.filter((i) => {
        const entered = counts[i.id];
        return entered !== undefined && entered !== "" && Number(entered) !== Number(i.onHand);
      }).length,
    [counts, ingredients],
  );

  function submit() {
    const lines = ingredients
      .filter((i) => counts[i.id] !== undefined && counts[i.id] !== "")
      .map((i) => ({ ingredientId: i.id, countedQuantity: Number(counts[i.id]) }));

    if (lines.length === 0) {
      setError("Enter at least one counted quantity");
      return;
    }
    if (
      !confirmed(
        `Submit this count? ${changedCount} ingredient${changedCount === 1 ? "" : "s"} will be adjusted to match what you entered.`,
      )
    ) {
      return;
    }

    setMessage(null);
    setError(null);
    const fd = new FormData();
    fd.set("countsJson", JSON.stringify(lines));
    startTransition(async () => {
      const res = await runCycleCountAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setMessage(
        res.result.lines.length === 0
          ? "Count submitted — nothing differed from on-hand"
          : `Count submitted — ${res.result.lines.length} ingredient(s) adjusted`,
      );
      setCounts({});
    });
  }

  return (
    <div className="space-y-4">
      <div className="panel overflow-x-auto p-4">
        <table className="table">
          <thead>
            <tr>
              <th>Ingredient</th>
              <th>On hand</th>
              <th>Counted</th>
              <th>Variance</th>
            </tr>
          </thead>
          <tbody>
            {ingredients.map((i) => {
              const entered = counts[i.id] ?? "";
              const variance =
                entered !== "" ? (Number(entered) - Number(i.onHand)).toString() : null;
              return (
                <tr key={i.id}>
                  <td className="font-medium">
                    {i.name} <span style={{ color: "var(--muted)" }}>({i.unit})</span>
                  </td>
                  <td>{i.onHand}</td>
                  <td>
                    <input
                      className="field w-28"
                      type="number"
                      step="any"
                      min="0"
                      placeholder={i.onHand}
                      value={entered}
                      onChange={(e) =>
                        setCounts((c) => ({ ...c, [i.id]: e.target.value }))
                      }
                    />
                  </td>
                  <td
                    style={
                      variance !== null && Number(variance) !== 0
                        ? { color: "var(--danger)" }
                        : undefined
                    }
                  >
                    {variance ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {changedCount} of {ingredients.length} ingredients differ from on-hand.
        </p>
        <button type="button" className="btn-primary" disabled={pending} onClick={submit}>
          {pending ? "Submitting…" : "Submit count"}
        </button>
      </div>
      {message && <p className="text-sm">{message}</p>}
      {error && (
        <p className="text-sm" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
