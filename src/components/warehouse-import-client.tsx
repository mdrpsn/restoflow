"use client";

import Link from "next/link";
import { Fragment, useRef, useState, useTransition } from "react";
import { applyWarehouseImportAction, previewWarehouseImportAction } from "@/actions";
import { Badge, type BadgeTone } from "@/components/badge";
import { IngredientCombobox } from "@/components/ingredient-combobox";
import type { ImportPreview, ImportSummary } from "@/lib/warehouseImport";
import type { PlanRow, StepKind } from "@/lib/warehouseImportCore";

type Ingredient = { id: string; name: string; unit: string };
type RecentImport = {
  id: string;
  sheetDate: string;
  fileName: string;
  countedBy: string | null;
  rowsApplied: number;
  importedBy: string | null;
  createdAt: string;
};

const STEP_LABEL: Record<StepKind, string> = {
  OPENING: "opening balance",
  RECEIVE: "received",
  SURPLUS: "correction",
  WASTE: "waste",
  RECONCILE: "count adjustment",
};

function signed(delta: string): string {
  return delta.startsWith("-") ? `−${delta.slice(1)}` : `+${delta}`;
}

function rowStatus(r: PlanRow): { label: string; tone: BadgeTone } {
  if (r.needsMatch) return { label: "Needs match", tone: "warn" };
  if (r.errors.length) return { label: "Error", tone: "bad" };
  if (r.steps.length > 0 || r.policy) return { label: "Ready", tone: "good" };
  return { label: "No change", tone: "neutral" };
}

export function WarehouseImportClient({
  ingredients,
  recent,
}: {
  ingredients: Ingredient[];
  recent: RecentImport[];
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [confirmSameDate, setConfirmSameDate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [busy, startTransition] = useTransition();

  function form(f: File, m: Record<string, string>, extra: Record<string, string> = {}) {
    const fd = new FormData();
    fd.set("file", f);
    fd.set("mappings", JSON.stringify(m));
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return fd;
  }

  function runPreview(f: File, m: Record<string, string>) {
    setError(null);
    startTransition(async () => {
      const res = await previewWarehouseImportAction(form(f, m));
      if (!res.ok) {
        setPreview(null);
        setError(res.error);
        return;
      }
      setPreview(res.preview);
    });
  }

  function onPickFile(f: File | null) {
    setResult(null);
    setPreview(null);
    setMappings({});
    setConfirmSameDate(false);
    setError(null);
    setFile(f);
    if (f) runPreview(f, {});
  }

  function setMapping(rowNumber: number, ingredientId: string | null) {
    if (!file) return;
    const next = { ...mappings };
    if (ingredientId) next[String(rowNumber)] = ingredientId;
    else delete next[String(rowNumber)];
    setMappings(next);
    runPreview(file, next);
  }

  function apply() {
    if (!file) return;
    setError(null);
    startTransition(async () => {
      const res = await applyWarehouseImportAction(
        form(file, mappings, { confirmSameDate: String(confirmSameDate) }),
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setResult(res.summary);
      setPreview(null);
      setFile(null);
      setMappings({});
      setConfirmSameDate(false);
      if (inputRef.current) inputRef.current.value = "";
    });
  }

  const plan = preview?.plan ?? null;
  const usedIds = plan ? plan.rows.map((r) => r.match?.id).filter((id): id is string => !!id) : [];
  const needsConfirm = !!preview && preview.previousImportsForDate.length > 0;
  const skippedCount = plan ? plan.needsMatchRows + plan.errorRows : 0;
  const canApply = !!plan && !busy && plan.blockers.length === 0 && plan.readyRows > 0 && (!needsConfirm || confirmSameDate);

  return (
    <div className="space-y-4">
      <div className="panel space-y-3 p-4">
        <h2 className="text-lg font-semibold">1. Choose the filled-in sheet</h2>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Use the warehouse daily count template. Only the yellow cells are read.{" "}
          <a href="/templates/warehouse-daily-count.xlsx" download className="underline" style={{ color: "var(--accent)" }}>
            Download the blank template
          </a>
        </p>
        <label className="label" htmlFor="count-sheet">
          Excel file (.xlsx)
        </label>
        <input
          id="count-sheet"
          ref={inputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="field"
          disabled={busy}
          onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
        />
        {busy && !plan && (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Reading the sheet…
          </p>
        )}
        {error && (
          <p className="text-sm" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
      </div>

      {result && (
        <div className="panel space-y-2 p-4" style={{ borderColor: "var(--accent)" }}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">Import applied</h2>
            <Badge tone="good">Saved</Badge>
          </div>
          <ul className="num text-sm">
            <li>{result.rowsApplied} item(s) updated</li>
            {result.rowsSkipped > 0 && <li>{result.rowsSkipped} row(s) skipped because of errors</li>}
            {result.rowsUnchanged > 0 && <li>{result.rowsUnchanged} row(s) already matched the system</li>}
            <li>
              Movements posted:{" "}
              {(Object.keys(result.movements) as StepKind[])
                .filter((k) => result.movements[k] > 0)
                .map((k) => `${result.movements[k]} ${STEP_LABEL[k]}`)
                .join(", ") || "none"}
            </li>
            {result.policiesSet > 0 && <li>{result.policiesSet} par/low-stock setting(s) updated</li>}
          </ul>
          <Link href="/inventory" className="btn-secondary">
            View inventory →
          </Link>
        </div>
      )}

      {plan && preview && (
        <div className="panel space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">2. Review</h2>
            <div className="num text-xs" style={{ color: "var(--muted)" }}>
              {preview.fileName} · {plan.meta.date ?? "no date"} · {plan.meta.branchName ?? "no branch"}
              {plan.meta.countedBy ? ` · counted by ${plan.meta.countedBy}` : ""}
            </div>
          </div>

          {plan.blockers.length > 0 && (
            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: "var(--danger)", background: "#fef3f2" }}>
              <div className="mb-1 font-semibold" style={{ color: "var(--danger)" }}>
                Can&apos;t import yet
              </div>
              <ul className="list-disc space-y-1 pl-5">
                {plan.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}

          {plan.warnings.length > 0 && (
            <div className="rounded-lg border p-3 text-sm" style={{ borderColor: "var(--warn)", background: "#fff8f0" }}>
              <ul className="list-disc space-y-1 pl-5">
                {plan.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Badge tone="good">{plan.readyRows} ready</Badge>
            {plan.needsMatchRows > 0 && <Badge tone="warn">{plan.needsMatchRows} need a match</Badge>}
            {plan.errorRows > 0 && <Badge tone="bad">{plan.errorRows} with errors</Badge>}
            {plan.unchangedRows > 0 && <Badge tone="neutral">{plan.unchangedRows} no change</Badge>}
          </div>

          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Item</th>
                  <th>System now</th>
                  <th>Counted</th>
                  <th>Changes</th>
                  <th>Result</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((r) => {
                  const status = rowStatus(r);
                  const hasDetail = r.errors.length > 0 || r.warnings.length > 0 || (!r.match && r.suggestions.length > 0);
                  return (
                    <Fragment key={r.rowNumber}>
                      <tr>
                        <td className="num">{r.rowNumber}</td>
                        <td>
                          <div className="font-medium">{r.itemName || "(no name)"}</div>
                          {r.match && (
                            <div className="text-xs" style={{ color: "var(--muted)" }}>
                              → {r.match.name}
                              {r.match.name.toLowerCase().includes(`(${r.match.unit.toLowerCase()})`) ? "" : ` (${r.match.unit})`}{" "}
                              {r.matchedBy === "manual" && (
                                <button
                                  type="button"
                                  className="underline"
                                  onClick={() => setMapping(r.rowNumber, null)}
                                  disabled={busy}
                                >
                                  change
                                </button>
                              )}
                            </div>
                          )}
                          <div className="num text-xs" style={{ color: "var(--muted)" }}>
                            open {r.opening ?? "–"} · in {r.received ?? "–"} · out {r.transferredOut ?? "–"} · waste{" "}
                            {r.wastage ?? "–"}
                          </div>
                        </td>
                        <td className="num">{r.match ? (r.systemQuantity ?? "not tracked yet") : "—"}</td>
                        <td className="num">{r.actual ?? "—"}</td>
                        <td className="num text-xs">
                          {r.steps.length === 0 && !r.policy && "—"}
                          {r.steps.map((s) => (
                            <div key={s.kind}>
                              {signed(s.delta)} {STEP_LABEL[s.kind]}
                            </div>
                          ))}
                          {r.policy && (
                            <div>
                              low {r.policy.lowStockAt}
                              {r.policy.parLevel ? ` · par ${r.policy.parLevel}` : ""}
                            </div>
                          )}
                        </td>
                        <td className="num">{r.resultingQuantity ?? "—"}</td>
                        <td>
                          <Badge tone={status.tone}>{status.label}</Badge>
                        </td>
                      </tr>
                      {hasDetail && (
                        <tr>
                          <td />
                          <td colSpan={6} className="space-y-2 pb-3 text-xs">
                            {!r.match && (
                              <div className="space-y-2">
                                {r.suggestions.length > 0 && (
                                  <div className="flex flex-wrap items-center gap-1">
                                    <span style={{ color: "var(--muted)" }}>Did you mean:</span>
                                    {r.suggestions.map((s) => (
                                      <button
                                        key={s.id}
                                        type="button"
                                        className="btn-secondary px-2 py-1 text-xs"
                                        disabled={busy}
                                        onClick={() => setMapping(r.rowNumber, s.id)}
                                      >
                                        {s.name}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                <div className="max-w-sm">
                                  <IngredientCombobox
                                    ingredients={ingredients}
                                    excludeIds={usedIds}
                                    value={mappings[String(r.rowNumber)] ?? ""}
                                    onCommit={(id) => setMapping(r.rowNumber, id)}
                                  />
                                </div>
                              </div>
                            )}
                            {r.errors
                              .filter((e) => !(r.needsMatch && e.startsWith("Not matched")))
                              .map((e) => (
                                <div key={e} style={{ color: "var(--danger)" }}>
                                  {e}
                                </div>
                              ))}
                            {r.warnings.map((w) => (
                              <div key={w} style={{ color: "var(--warn)" }}>
                                {w}
                              </div>
                            ))}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {needsConfirm && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmSameDate}
                onChange={(e) => setConfirmSameDate(e.target.checked)}
              />
              <span>
                A count for {plan.meta.date} was already imported (
                {preview.previousImportsForDate.map((p) => p.fileName).join(", ")}). I want to import this file too.
              </span>
            </label>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-primary" disabled={!canApply} onClick={apply}>
              {busy ? "Working…" : `Apply ${plan.readyRows} row${plan.readyRows === 1 ? "" : "s"}`}
            </button>
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              Everything is saved together or not at all.
              {skippedCount > 0 ? ` ${skippedCount} row(s) with problems will be skipped.` : ""}
            </span>
          </div>
        </div>
      )}

      <div className="panel p-4">
        <h2 className="mb-3 text-lg font-semibold">Recent imports</h2>
        {recent.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Nothing imported yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Sheet date</th>
                  <th>File</th>
                  <th>Counted by</th>
                  <th>Items</th>
                  <th>Imported by</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((i) => (
                  <tr key={i.id}>
                    <td className="num">{i.sheetDate}</td>
                    <td>{i.fileName}</td>
                    <td>{i.countedBy ?? "—"}</td>
                    <td className="num">{i.rowsApplied}</td>
                    <td>{i.importedBy ?? "—"}</td>
                    <td className="num text-xs">{new Date(i.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
