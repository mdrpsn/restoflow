"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  cancelTransferAction,
  createTransferAction,
  receiveTransferAction,
  shipTransferAction,
} from "@/actions";
import { confirmed } from "@/lib/confirm";
import { IngredientCombobox } from "@/components/ingredient-combobox";
import { Badge, type BadgeTone } from "@/components/badge";
import { formatNumber, formatQty, packToBase } from "@/lib/packs";

function transferTone(status: string): BadgeTone {
  if (status === "RECEIVED") return "good";
  if (status === "CANCELLED") return "bad";
  if (status === "IN_TRANSIT") return "warn";
  return "neutral";
}

type Branch = { id: string; name: string; code: string; type: string };
type Pack = { id: string; name: string; size: number; isDefault: boolean };
type Ingredient = { id: string; name: string; unit: string; packs: Pack[] };
type TransferLine = {
  id: string;
  ingredientName: string;
  unit: string;
  quantity: string;
  packLabel: string | null;
  packQuantity: string | null;
};
type FormLine = { ingredientId: string; quantity: number; packId: string };
type Transfer = {
  id: string;
  status: string;
  fromBranchName: string;
  fromBranchId: string;
  toBranchName: string;
  toBranchId: string;
  note: string | null;
  createdAt: string;
  shippedAt: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  lines: TransferLine[];
};

export function TransfersClient({
  branchId,
  branchName,
  branches,
  ingredients,
  transfers,
}: {
  branchId: string;
  branchName: string;
  branches: Branch[];
  ingredients: Ingredient[];
  transfers: Transfer[];
}) {
  const destinations = branches.filter((b) => b.id !== branchId);
  const [lines, setLines] = useState<FormLine[]>([{ ingredientId: "", quantity: 1, packId: "" }]);
  const [toBranchId, setToBranchId] = useState(destinations[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const ingredientRefs = useRef<Array<HTMLInputElement | null>>([]);
  const qtyRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [pendingFocusIndex, setPendingFocusIndex] = useState<number | null>(null);

  useEffect(() => {
    if (pendingFocusIndex !== null) {
      ingredientRefs.current[pendingFocusIndex]?.focus();
      setPendingFocusIndex(null);
    }
  }, [pendingFocusIndex]);

  function updateLine(idx: number, patch: Partial<FormLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  /** Picking an ingredient preselects its default pack (the unit the warehouse ships in). */
  function pickIngredient(idx: number, ingredientId: string) {
    const ing = ingredients.find((i) => i.id === ingredientId);
    const def = ing?.packs.find((p) => p.isDefault) ?? null;
    updateLine(idx, { ingredientId, packId: def?.id ?? "" });
  }

  function addLine(focus = false) {
    setLines((prev) => {
      const next = [...prev, { ingredientId: "", quantity: 1, packId: "" }];
      if (focus) setPendingFocusIndex(next.length - 1);
      return next;
    });
  }

  function removeLine(idx: number) {
    if (lines.length === 1) {
      updateLine(idx, { ingredientId: "", quantity: 1, packId: "" });
      return;
    }
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  /** Enter (or Tab past the last line) in a quantity field: move on to the next line, creating one if this was the last. */
  function advanceFromQty(idx: number) {
    const line = lines[idx];
    if (line.ingredientId === "" || line.quantity <= 0) return;
    if (idx === lines.length - 1) {
      addLine(true);
    } else {
      ingredientRefs.current[idx + 1]?.focus();
    }
  }

  function create() {
    setMessage(null);
    const validLines = lines.filter((l) => l.ingredientId !== "" && l.quantity > 0);
    if (validLines.length === 0) {
      setMessage("Add at least one ingredient line");
      return;
    }
    const fd = new FormData();
    fd.set("toBranchId", toBranchId);
    fd.set("note", note);
    fd.set(
      "linesJson",
      JSON.stringify(
        validLines.map((l) => ({ ingredientId: l.ingredientId, quantity: l.quantity, packId: l.packId || null })),
      ),
    );
    startTransition(async () => {
      const res = await createTransferAction(fd);
      if (res.ok) {
        setLines([{ ingredientId: "", quantity: 1, packId: "" }]);
        setNote("");
      }
      setMessage(res.ok ? "Transfer created as DRAFT" : res.error);
    });
  }

  function act(
    action: typeof shipTransferAction,
    transferId: string,
    successMessage: string,
    confirmMessage?: string,
  ) {
    if (confirmMessage && !confirmed(confirmMessage)) return;
    const fd = new FormData();
    fd.set("transferId", transferId);
    startTransition(async () => {
      const res = await action(fd);
      setMessage(res.ok ? successMessage : res.error);
    });
  }

  return (
    <div className="space-y-6">
      <div className="panel space-y-3 p-4">
        <h2 className="font-semibold">New transfer from {branchName}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label">Destination</label>
            <select
              className="field"
              value={toBranchId}
              onChange={(e) => setToBranchId(e.target.value)}
            >
              {destinations.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name} {b.type === "WAREHOUSE" ? "(warehouse)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Note</label>
            <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Type to search, ↑/↓ to highlight, Enter to pick — then Enter (or Tab) after the
            quantity moves to the next line, adding one if needed.
          </p>
          {lines.map((line, idx) => {
            const excludeIds = lines
              .filter((_, i) => i !== idx)
              .map((l) => l.ingredientId)
              .filter(Boolean);
            const isLast = idx === lines.length - 1;
            const ing = ingredients.find((i) => i.id === line.ingredientId);
            const pack = ing?.packs.find((p) => p.id === line.packId);
            return (
              <div key={idx} className="grid gap-2 md:grid-cols-[2fr_1fr_1.2fr_auto]">
                <IngredientCombobox
                  ingredients={ingredients}
                  excludeIds={excludeIds}
                  value={line.ingredientId}
                  autoFocus={idx === 0}
                  inputRef={(el) => {
                    ingredientRefs.current[idx] = el;
                  }}
                  onCommit={(id) => pickIngredient(idx, id)}
                  onCommitNext={() => qtyRefs.current[idx]?.focus()}
                />
                <input
                  ref={(el) => {
                    qtyRefs.current[idx] = el;
                  }}
                  className="field"
                  type="number"
                  min="0.0001"
                  step="any"
                  value={line.quantity}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => updateLine(idx, { quantity: Number(e.target.value) })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      advanceFromQty(idx);
                    } else if (e.key === "Tab" && !e.shiftKey && isLast) {
                      const valid = line.ingredientId !== "" && line.quantity > 0;
                      if (valid) {
                        e.preventDefault();
                        addLine(true);
                      }
                    }
                  }}
                />
                <select
                  className="field"
                  tabIndex={-1}
                  disabled={!ing}
                  value={line.packId}
                  onChange={(e) => updateLine(idx, { packId: e.target.value })}
                  aria-label="Unit"
                >
                  <option value="">{ing ? `${ing.unit} (base unit)` : "unit"}</option>
                  {ing?.packs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn-secondary" tabIndex={-1} onClick={() => removeLine(idx)}>
                  ×
                </button>
                {pack && line.quantity > 0 && (
                  <p className="text-xs md:col-span-4" style={{ color: "var(--muted)" }}>
                    {formatNumber(line.quantity)} × {pack.name} = {formatQty(packToBase(line.quantity, pack), ing!.unit)} will be
                    transferred
                  </p>
                )}
              </div>
            );
          })}
          <button type="button" className="btn-secondary" onClick={() => addLine(true)}>
            Add line
          </button>
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={pending || !toBranchId || lines.every((l) => l.ingredientId === "")}
          onClick={create}
        >
          Create draft transfer
        </button>
        {message && <p className="text-sm">{message}</p>}
      </div>

      <div className="space-y-4">
        {transfers.map((t) => (
          <div key={t.id} className="panel p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-semibold flex flex-wrap items-center gap-2">
                  <span>{t.fromBranchName} → {t.toBranchName}</span>
                  <Badge tone={transferTone(t.status)}>{t.status}</Badge>
                </div>
                <div className="text-xs" style={{ color: "var(--muted)" }}>
                  Created {new Date(t.createdAt).toLocaleString()}
                  {t.shippedAt ? ` · Shipped ${new Date(t.shippedAt).toLocaleString()}` : ""}
                  {t.receivedAt ? ` · Received ${new Date(t.receivedAt).toLocaleString()}` : ""}
                  {t.cancelledAt ? ` · Cancelled ${new Date(t.cancelledAt).toLocaleString()}` : ""}
                  {t.note ? ` · ${t.note}` : ""}
                </div>
              </div>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Ingredient</th>
                  <th>Quantity</th>
                </tr>
              </thead>
              <tbody>
                {t.lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.ingredientName} <span style={{ color: "var(--muted)" }}>({l.unit})</span>
                    </td>
                    <td>
                      {l.packLabel && l.packQuantity ? (
                        <>
                          {formatNumber(Number(l.packQuantity))} × {l.packLabel}{" "}
                          <span style={{ color: "var(--muted)" }}>
                            = {formatQty(Number(l.quantity), l.unit)}
                          </span>
                        </>
                      ) : (
                        formatQty(Number(l.quantity), l.unit)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex gap-2">
              {t.status === "DRAFT" && t.fromBranchId === branchId && (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={pending}
                  onClick={() =>
                    act(
                      shipTransferAction,
                      t.id,
                      "Transfer shipped",
                      `Ship this transfer? Stock will leave ${t.fromBranchName} now.`,
                    )
                  }
                >
                  Ship
                </button>
              )}
              {t.status === "IN_TRANSIT" && t.toBranchId === branchId && (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={pending}
                  onClick={() => act(receiveTransferAction, t.id, "Transfer received")}
                >
                  Receive
                </button>
              )}
              {(t.status === "DRAFT" || t.status === "IN_TRANSIT") && (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={pending}
                  onClick={() =>
                    act(
                      cancelTransferAction,
                      t.id,
                      "Transfer cancelled",
                      t.status === "IN_TRANSIT"
                        ? "Cancel this transfer? Stock already shipped will be reversed back to the source."
                        : "Cancel this transfer?",
                    )
                  }
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        ))}
        {transfers.length === 0 && (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No transfers yet.
          </p>
        )}
      </div>
    </div>
  );
}
