"use client";

import { useState, useTransition } from "react";
import { cancelPurchaseOrderAction, createPurchaseOrderAction, receivePoAction } from "@/actions";
import { formatMoney } from "@/lib/money";
import { confirmed } from "@/lib/confirm";
import { Badge, type BadgeTone } from "@/components/badge";

function poTone(status: string): BadgeTone {
  if (status === "RECEIVED") return "good";
  if (status === "CANCELLED") return "bad";
  if (status === "ORDERED" || status === "PARTIAL") return "warn";
  return "neutral";
}

type Supplier = { id: string; name: string };
type Ingredient = { id: string; name: string; unit: string; costCentsPerUnit: number };
type PoLine = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  unit: string;
  quantityOrdered: string;
  quantityReceived: string;
  unitCostCents: number;
};
type Po = {
  id: string;
  status: string;
  supplierName: string;
  branchName: string;
  note: string | null;
  createdAt: string;
  lines: PoLine[];
};

export function OrdersClient({
  suppliers,
  ingredients,
  orders,
  branchName,
}: {
  suppliers: Supplier[];
  ingredients: Ingredient[];
  orders: Po[];
  branchName: string;
}) {
  const [lines, setLines] = useState<
    { ingredientId: string; quantityOrdered: number; unitCostCents: number }[]
  >([{ ingredientId: ingredients[0]?.id ?? "", quantityOrdered: 10, unitCostCents: 0 }]);
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [receipts, setReceipts] = useState<Record<string, Record<string, number>>>({});

  function createPo() {
    setMessage(null);
    const fd = new FormData();
    fd.set("supplierId", supplierId);
    fd.set("note", note);
    fd.set("linesJson", JSON.stringify(lines));
    startTransition(async () => {
      const res = await createPurchaseOrderAction(fd);
      setMessage(res.ok ? "PO created for " + branchName : res.error);
    });
  }

  function cancel(po: Po) {
    if (!confirmed(`Cancel this PO from ${po.supplierName}? This cannot be undone.`)) return;
    const fd = new FormData();
    fd.set("purchaseOrderId", po.id);
    startTransition(async () => {
      const res = await cancelPurchaseOrderAction(fd);
      setMessage(res.ok ? "PO cancelled" : res.error);
    });
  }

  function receive(po: Po) {
    const linesMap = receipts[po.id] || {};
    const payload = po.lines
      .map((l) => ({
        lineId: l.id,
        quantity: linesMap[l.id] ?? 0,
      }))
      .filter((r) => r.quantity > 0);
    const fd = new FormData();
    fd.set("purchaseOrderId", po.id);
    fd.set("receiptsJson", JSON.stringify(payload));
    startTransition(async () => {
      const res = await receivePoAction(fd);
      setMessage(res.ok ? "Receipt posted" : res.error);
    });
  }

  return (
    <div className="space-y-6">
      <div className="panel space-y-3 p-4">
        <h2 className="font-semibold">New purchase order → {branchName}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label">Supplier</label>
            <select className="field" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
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
          {lines.map((line, idx) => (
            <div key={idx} className="grid gap-2 md:grid-cols-[2fr_1fr_1fr_auto]">
              <select
                className="field"
                value={line.ingredientId}
                onChange={(e) => {
                  const ing = ingredients.find((i) => i.id === e.target.value);
                  const next = [...lines];
                  next[idx] = {
                    ...next[idx],
                    ingredientId: e.target.value,
                    unitCostCents: ing?.costCentsPerUnit ?? 0,
                  };
                  setLines(next);
                }}
              >
                {ingredients.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
              <input
                className="field"
                type="number"
                min="0.0001"
                step="any"
                value={line.quantityOrdered}
                onChange={(e) => {
                  const next = [...lines];
                  next[idx] = { ...next[idx], quantityOrdered: Number(e.target.value) };
                  setLines(next);
                }}
              />
              <input
                className="field"
                type="number"
                min="0"
                step="1"
                value={line.unitCostCents}
                onChange={(e) => {
                  const next = [...lines];
                  next[idx] = { ...next[idx], unitCostCents: Number(e.target.value) };
                  setLines(next);
                }}
                title="Unit cost cents"
              />
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setLines(lines.filter((_, i) => i !== idx))}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              setLines([
                ...lines,
                {
                  ingredientId: ingredients[0]?.id ?? "",
                  quantityOrdered: 1,
                  unitCostCents: ingredients[0]?.costCentsPerUnit ?? 0,
                },
              ])
            }
          >
            Add line
          </button>
        </div>
        <button type="button" className="btn-primary" disabled={pending} onClick={createPo}>
          Create ordered PO
        </button>
        {message && <p className="text-sm">{message}</p>}
      </div>

      <div className="space-y-4">
        {orders.map((po) => (
          <div key={po.id} className="panel p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-semibold flex flex-wrap items-center gap-2">
                  <span>{po.supplierName}</span>
                  <Badge tone={poTone(po.status)}>{po.status}</Badge>
                </div>
                <div className="text-xs" style={{ color: "var(--muted)" }}>
                  {po.branchName} · {new Date(po.createdAt).toLocaleString()}
                  {po.note ? ` · ${po.note}` : ""}
                </div>
              </div>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Ingredient</th>
                  <th>Ordered</th>
                  <th>Received</th>
                  <th>Unit cost</th>
                  <th>Receive now</th>
                </tr>
              </thead>
              <tbody>
                {po.lines.map((l) => {
                  const remaining =
                    Number(l.quantityOrdered) - Number(l.quantityReceived);
                  return (
                    <tr key={l.id}>
                      <td>
                        {l.ingredientName}{" "}
                        <span style={{ color: "var(--muted)" }}>({l.unit})</span>
                      </td>
                      <td className="num">{l.quantityOrdered}</td>
                      <td className="num">{l.quantityReceived}</td>
                      <td className="num">{formatMoney(l.unitCostCents)}</td>
                      <td>
                        {remaining > 0 && po.status !== "CANCELLED" && po.status !== "DRAFT" ? (
                          <input
                            className="field w-28"
                            type="number"
                            min="0"
                            max={remaining}
                            step="any"
                            placeholder={`≤ ${remaining}`}
                            value={receipts[po.id]?.[l.id] ?? ""}
                            onChange={(e) =>
                              setReceipts((r) => ({
                                ...r,
                                [po.id]: {
                                  ...(r[po.id] || {}),
                                  [l.id]: Number(e.target.value),
                                },
                              }))
                            }
                          />
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {po.status !== "RECEIVED" && po.status !== "CANCELLED" && po.status !== "DRAFT" && (
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={pending}
                  onClick={() => receive(po)}
                >
                  Post receipt
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={pending}
                  onClick={() => cancel(po)}
                >
                  Cancel PO
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
