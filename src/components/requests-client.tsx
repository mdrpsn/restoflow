"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  approveStockRequestAction,
  createStockRequestAction,
  rejectStockRequestAction,
  submitAutomatedStockRequestDraftAction,
} from "@/actions";
import { IngredientCombobox } from "@/components/ingredient-combobox";
import { Badge, type BadgeTone } from "@/components/badge";

type Ingredient = { id: string; name: string; unit: string };
type MyRequestLine = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  unit: string;
  quantity: string;
  approvedQuantity: string | null;
};
type MyRequest = {
  id: string;
  status: string;
  source: string;
  note: string | null;
  rejectionReason: string | null;
  createdAt: string;
  reviewedAt: string | null;
  requestedByName: string;
  lines: MyRequestLine[];
};
type IncomingLine = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  unit: string;
  quantity: string;
};
type IncomingRequest = {
  id: string;
  note: string | null;
  createdAt: string;
  branchName: string;
  requestedByName: string;
  lines: IncomingLine[];
};

export function RequestsClient({
  canRequest,
  branchName,
  isWhAdmin,
  canSubmitDraft,
  ingredients,
  myRequests,
  incomingRequests,
}: {
  canRequest: boolean;
  branchName: string;
  isWhAdmin: boolean;
  canSubmitDraft: boolean;
  ingredients: Ingredient[];
  myRequests: MyRequest[];
  incomingRequests: IncomingRequest[];
}) {
  return (
    <div className="space-y-6">
      {canRequest && (
        <NewRequestForm ingredients={ingredients} branchName={branchName} />
      )}

      {isWhAdmin && incomingRequests.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Incoming requests to review</h2>
          {incomingRequests.map((r) => (
            <IncomingRequestCard key={r.id} request={r} />
          ))}
        </div>
      )}

      <div className="panel p-4">
        <h2 className="mb-3 font-semibold">
          {branchName}&apos;s requests
        </h2>
        {myRequests.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No requests yet.
          </p>
        ) : (
          <div className="space-y-3">
            {myRequests.map((r) => (
              r.status === "DRAFT" && canSubmitDraft ? (
                <AutomationDraftCard key={r.id} request={r} />
              ) : (
              <div key={r.id} className="rounded-lg border p-3" style={{ borderColor: "var(--line)" }}>
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium">
                    {new Date(r.createdAt).toLocaleString()} · {r.requestedByName}
                  </span>
                  <StatusBadge status={r.status} />
                </div>
                <ul className="text-sm" style={{ color: "var(--muted)" }}>
                  {r.lines.map((l) => (
                    <li key={l.id}>
                      {l.ingredientName}: {l.quantity} {l.unit}
                      {l.approvedQuantity !== null && l.approvedQuantity !== l.quantity && (
                        <> — approved {l.approvedQuantity} {l.unit}</>
                      )}
                    </li>
                  ))}
                </ul>
                {r.note && <p className="mt-1 text-xs">{r.note}</p>}
                {r.status === "REJECTED" && r.rejectionReason && (
                  <p className="mt-1 text-xs" style={{ color: "var(--danger)" }}>
                    Rejected: {r.rejectionReason}
                  </p>
                )}
                {r.status === "APPROVED" && (
                  <p className="mt-1 text-xs" style={{ color: "var(--accent)" }}>
                    Approved — converted to a transfer for the warehouse to ship.
                  </p>
                )}
              </div>
              )
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AutomationDraftCard({ request }: { request: MyRequest }) {
  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(request.lines.map((line) => [line.ingredientId, Number(line.quantity)])),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    const lines = request.lines
      .map((line) => ({ ingredientId: line.ingredientId, quantity: quantities[line.ingredientId] }))
      .filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);
    if (!lines.length) {
      setMessage("Keep at least one positive draft line");
      return;
    }
    const fd = new FormData();
    fd.set("requestId", request.id);
    fd.set("linesJson", JSON.stringify(lines));
    startTransition(async () => {
      const result = await submitAutomatedStockRequestDraftAction(fd);
      setMessage(result.ok ? "Submitted to the warehouse for approval" : result.error);
    });
  }

  return (
    <div className="rounded-lg border p-3" style={{ borderColor: "var(--warn)", background: "#fff8f0" }}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">Automated replenishment proposal</span>
        <StatusBadge status={request.status} />
      </div>
      <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
        Review the proposed quantities. Submitting records you as the requester; inventory does not move until the warehouse approves, ships, and the branch receives it.
      </p>
      <div className="space-y-2">
        {request.lines.map((line) => (
          <label key={line.id} className="grid grid-cols-[1fr_8rem] items-center gap-2 text-sm">
            <span>{line.ingredientName} ({line.unit})</span>
            <input
              className="field"
              type="number"
              min="0.0001"
              step="any"
              value={quantities[line.ingredientId]}
              onChange={(event) => setQuantities((current) => ({
                ...current,
                [line.ingredientId]: Number(event.target.value),
              }))}
            />
          </label>
        ))}
      </div>
      <button type="button" className="btn-primary mt-3" disabled={pending} onClick={submit}>
        {pending ? "Submitting…" : "Submit request"}
      </button>
      {message && <p className="mt-2 text-sm">{message}</p>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone: BadgeTone =
    status === "APPROVED" ? "good" : status === "REJECTED" ? "bad" : status === "PENDING" ? "warn" : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

function NewRequestForm({ ingredients, branchName }: { ingredients: Ingredient[]; branchName: string }) {
  const [lines, setLines] = useState<{ ingredientId: string; quantity: number }[]>([
    { ingredientId: "", quantity: 1 },
  ]);
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

  function updateLine(idx: number, patch: Partial<{ ingredientId: string; quantity: number }>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function addLine(focus = false) {
    setLines((prev) => {
      const next = [...prev, { ingredientId: "", quantity: 1 }];
      if (focus) setPendingFocusIndex(next.length - 1);
      return next;
    });
  }

  function removeLine(idx: number) {
    if (lines.length === 1) {
      updateLine(idx, { ingredientId: "", quantity: 1 });
      return;
    }
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  function advanceFromQty(idx: number) {
    const line = lines[idx];
    if (line.ingredientId === "" || line.quantity <= 0) return;
    if (idx === lines.length - 1) {
      addLine(true);
    } else {
      ingredientRefs.current[idx + 1]?.focus();
    }
  }

  function submit() {
    setMessage(null);
    const validLines = lines.filter((l) => l.ingredientId !== "" && l.quantity > 0);
    if (validLines.length === 0) {
      setMessage("Add at least one ingredient line");
      return;
    }
    const fd = new FormData();
    fd.set("note", note);
    fd.set("linesJson", JSON.stringify(validLines));
    startTransition(async () => {
      const res = await createStockRequestAction(fd);
      if (res.ok) {
        setLines([{ ingredientId: "", quantity: 1 }]);
        setNote("");
      }
      setMessage(res.ok ? "Request sent to the warehouse" : res.error);
    });
  }

  return (
    <div className="panel space-y-3 p-4">
      <h2 className="font-semibold">Request stock for {branchName}</h2>
      <div>
        <label className="label">Note</label>
        <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
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
          return (
            <div key={idx} className="grid gap-2 md:grid-cols-[2fr_1fr_auto]">
              <IngredientCombobox
                ingredients={ingredients}
                excludeIds={excludeIds}
                value={line.ingredientId}
                autoFocus={idx === 0}
                inputRef={(el) => {
                  ingredientRefs.current[idx] = el;
                }}
                onCommit={(id) => updateLine(idx, { ingredientId: id })}
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
              <button type="button" className="btn-secondary" tabIndex={-1} onClick={() => removeLine(idx)}>
                ×
              </button>
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
        disabled={pending || lines.every((l) => l.ingredientId === "")}
        onClick={submit}
      >
        Send request
      </button>
      {message && <p className="text-sm">{message}</p>}
    </div>
  );
}

function IncomingRequestCard({ request }: { request: IncomingRequest }) {
  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(request.lines.map((l) => [l.ingredientId, Number(l.quantity)])),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function approve() {
    setMessage(null);
    const fd = new FormData();
    fd.set("requestId", request.id);
    fd.set("approvedQuantitiesJson", JSON.stringify(quantities));
    startTransition(async () => {
      const res = await approveStockRequestAction(fd);
      setMessage(res.ok ? "Approved — a draft transfer was created" : res.error);
    });
  }

  function reject() {
    const reason = window.prompt("Reason for rejecting this request (optional):") ?? "";
    setMessage(null);
    const fd = new FormData();
    fd.set("requestId", request.id);
    fd.set("reason", reason);
    startTransition(async () => {
      const res = await rejectStockRequestAction(fd);
      setMessage(res.ok ? "Request rejected" : res.error);
    });
  }

  return (
    <div className="panel space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold">
            {request.branchName} · {request.requestedByName}
          </div>
          <div className="text-xs" style={{ color: "var(--muted)" }}>
            {new Date(request.createdAt).toLocaleString()}
            {request.note ? ` · ${request.note}` : ""}
          </div>
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Ingredient</th>
            <th>Requested</th>
            <th>Approve qty</th>
          </tr>
        </thead>
        <tbody>
          {request.lines.map((l) => (
            <tr key={l.id}>
              <td>
                {l.ingredientName} <span style={{ color: "var(--muted)" }}>({l.unit})</span>
              </td>
              <td>{l.quantity}</td>
              <td>
                <input
                  className="field"
                  type="number"
                  min="0"
                  step="any"
                  value={quantities[l.ingredientId]}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) =>
                    setQuantities((prev) => ({ ...prev, [l.ingredientId]: Number(e.target.value) }))
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex gap-2">
        <button type="button" className="btn-primary" disabled={pending} onClick={approve}>
          Approve
        </button>
        <button type="button" className="btn-secondary" disabled={pending} onClick={reject}>
          Reject
        </button>
      </div>
      {message && <p className="text-sm">{message}</p>}
    </div>
  );
}
