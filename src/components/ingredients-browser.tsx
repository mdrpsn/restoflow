"use client";

import { useMemo, useState } from "react";

type Pack = { id: string; name: string; size: string; isDefault: boolean };
type Ingredient = { id: string; name: string; unit: string; cost: string; packs: Pack[] };

export function IngredientsBrowser({ ingredients, deletePack }: {
  ingredients: Ingredient[];
  deletePack: (formData: FormData) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const filtered = useMemo(() => ingredients.filter(item =>
    item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  ), [ingredients, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / 40));
  const current = Math.min(page, pages);
  const shown = filtered.slice((current - 1) * 40, current * 40);

  return <section className="panel min-w-0 overflow-hidden">
    <div className="catalog-list-header"><div><h2>Ingredient catalog</h2><p>{ingredients.length} stockable items</p></div></div>
    <div className="catalog-list-search"><input className="field" type="search" aria-label="Search ingredients" placeholder="Search ingredients…" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} /></div>
    <div className="overflow-x-auto">
      <table className="table">
        <thead><tr><th>Name</th><th>Unit</th><th>Unit cost</th><th>Packs</th></tr></thead>
        <tbody>{shown.map(item => <tr key={item.id}>
          <td className="font-medium">{item.name}</td><td>{item.unit}</td><td className="num">{item.cost}</td>
          <td className="text-sm">
            {item.packs.length === 0 && <span style={{ color: "var(--muted)" }}>—</span>}
            {item.packs.map(pack => <form key={pack.id} action={deletePack} className="flex items-center gap-2">
              <input type="hidden" name="packId" value={pack.id} />
              <span>{pack.name} = {pack.size} {item.unit}{pack.isDefault ? " (default)" : ""}</span>
              <button type="submit" className="text-xs underline" style={{ color: "var(--muted)" }} aria-label={`Remove ${pack.name} pack from ${item.name}`}>remove</button>
            </form>)}
          </td>
        </tr>)}
        {shown.length === 0 && <tr><td colSpan={4} className="inventory-empty">No ingredients match your search.</td></tr>}
        </tbody>
      </table>
    </div>
    <div className="catalog-list-footer"><span>{filtered.length} matching items</span><div><button type="button" className="btn-secondary" disabled={current === 1} onClick={() => setPage(current - 1)}>Previous</button><span>{current} / {pages}</span><button type="button" className="btn-secondary" disabled={current === pages} onClick={() => setPage(current + 1)}>Next</button></div></div>
  </section>;
}
