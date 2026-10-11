"use client";

import { useMemo, useState } from "react";

export type InventoryRow = {
  id: string;
  name: string;
  onHand: string;
  lowAt: string;
  parLevel: string;
  unit: string;
  isLow: boolean;
  status: "Low stock" | "In stock" | "Zero on hand" | "Not counted";
};

const PAGE_SIZE = 40;

export function InventoryBrowser({ rows }: { rows: InventoryRow[] }) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"all" | "low">("all");
  const [page, setPage] = useState(1);
  const lowCount = rows.filter(row => row.isLow).length;
  const filtered = useMemo(() => rows.filter(row =>
    (view === "all" || row.isLow) && row.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  ), [rows, query, view]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const shown = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return <section className="panel inventory-browser">
    <div className="inventory-browser-header">
      <div><h2>Stock levels</h2><p>{rows.length} ingredients tracked at this location</p></div>
      <div className="inventory-browser-controls">
        <div className="inventory-segments" role="group" aria-label="Stock status">
          <button type="button" className={view === "all" ? "selected" : ""} onClick={() => { setView("all"); setPage(1); }}>All <span>{rows.length}</span></button>
          <button type="button" className={view === "low" ? "selected" : ""} onClick={() => { setView("low"); setPage(1); }}>Low stock <span>{lowCount}</span></button>
        </div>
        <input type="search" className="field inventory-search" aria-label="Search inventory" placeholder="Search ingredients…" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />
      </div>
    </div>
    <div className="inventory-table-scroll">
      <table className="table">
        <thead><tr><th>Ingredient</th><th>Status</th><th>On hand</th><th>Alert at</th><th>Par level</th><th>Unit</th></tr></thead>
        <tbody>
          {shown.map(row => <tr key={row.id}>
            <td className="font-medium">{row.name}</td>
            <td><span className={row.isLow ? "stock-status stock-status--low" : row.status === "In stock" ? "stock-status" : "stock-status stock-status--neutral"}>{row.status}</span></td>
            <td className="num">{row.onHand}</td><td className="num">{row.lowAt}</td><td className="num">{row.parLevel}</td><td>{row.unit}</td>
          </tr>)}
          {shown.length === 0 && <tr><td colSpan={6} className="inventory-empty">No ingredients match your search.</td></tr>}
        </tbody>
      </table>
    </div>
    <div className="inventory-browser-footer">
      <span>{filtered.length ? `Showing ${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, filtered.length)} of ${filtered.length}` : "0 results"}</span>
      <div><button type="button" className="btn-secondary" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage} of {pages}</span><button type="button" className="btn-secondary" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Next</button></div>
    </div>
  </section>;
}
