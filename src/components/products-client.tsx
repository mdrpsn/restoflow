"use client";

import { useMemo, useState, useTransition } from "react";
import { upsertProductAction, uploadProductImageAction, removeProductImageAction } from "@/actions";
import { formatMoney } from "@/lib/money";

type Ingredient = { id: string; name: string; unit: string; costCentsPerUnit: number };
type RecipeLine = { ingredientId: string; quantity: number };
type SweetnessLine = RecipeLine & { sweetnessPercent: number };
type ProductRow = {
  id: string;
  name: string;
  sku: string | null;
  priceCents: number;
  imageUrl: string | null;
  foodpandaPriceCents: number | null;
  grabfoodPriceCents: number | null;
  active: boolean;
  recipeLines: RecipeLine[];
  sweetnessLines: SweetnessLine[];
  theoreticalCostCents: number;
};

function ProductThumb({ name, imageUrl, size = 36 }: { name: string; imageUrl: string | null; size?: number }) {
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- local upload, thumbnail-sized
      <img src={imageUrl} alt="" style={{ width: size, height: size }} className="shrink-0 rounded-lg object-cover" />
    );
  }
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg font-bold"
      style={{ width: size, height: size, background: "var(--accent-soft)", color: "var(--accent)", fontSize: size * 0.36 }}
      aria-hidden="true"
    >
      {letters || "?"}
    </div>
  );
}

export function ProductsClient({
  products,
  ingredients,
}: {
  products: ProductRow[];
  ingredients: Ingredient[];
}) {
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [foodpandaPrice, setFoodpandaPrice] = useState("");
  const [grabfoodPrice, setGrabfoodPrice] = useState("");
  const [active, setActive] = useState(true);
  const [recipe, setRecipe] = useState<RecipeLine[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [imagePending, startImageTransition] = useTransition();
  const [imageError, setImageError] = useState<string | null>(null);
  const [productSearch, setProductSearch] = useState("");
  const [productPage, setProductPage] = useState(1);
  const filteredProducts = useMemo(() => products.filter(p =>
    `${p.name} ${p.sku || ""}`.toLocaleLowerCase().includes(productSearch.trim().toLocaleLowerCase()),
  ), [products, productSearch]);
  const productPages = Math.max(1, Math.ceil(filteredProducts.length / 30));
  const currentProductPage = Math.min(productPage, productPages);

  function startCreate() {
    setEditing(null);
    setName("");
    setSku("");
    setPrice("");
    setFoodpandaPrice("");
    setGrabfoodPrice("");
    setActive(true);
    setRecipe([]);
    setImageError(null);
    if (window.matchMedia("(max-width: 1279px)").matches) requestAnimationFrame(() => document.getElementById("product-editor")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function startEdit(p: ProductRow) {
    setEditing(p);
    setName(p.name);
    setSku(p.sku || "");
    setPrice((p.priceCents / 100).toFixed(2));
    setFoodpandaPrice(p.foodpandaPriceCents !== null ? (p.foodpandaPriceCents / 100).toFixed(2) : "");
    setGrabfoodPrice(p.grabfoodPriceCents !== null ? (p.grabfoodPriceCents / 100).toFixed(2) : "");
    setActive(p.active);
    setRecipe(p.recipeLines);
    setImageError(null);
    if (window.matchMedia("(max-width: 1279px)").matches) requestAnimationFrame(() => document.getElementById("product-editor")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  const theoretical = useMemo(() => {
    return recipe.reduce((sum, line) => {
      const ing = ingredients.find((i) => i.id === line.ingredientId);
      if (!ing) return sum;
      return sum + ing.costCentsPerUnit * line.quantity;
    }, 0);
  }, [recipe, ingredients]);

  const priceCents = Math.round((Number(price) || 0) * 100);

  function save() {
    setMessage(null);
    const fd = new FormData();
    if (editing) fd.set("id", editing.id);
    fd.set("name", name);
    fd.set("sku", sku);
    fd.set("price", price);
    fd.set("foodpandaPrice", foodpandaPrice);
    fd.set("grabfoodPrice", grabfoodPrice);
    fd.set("active", active ? "true" : "false");
    fd.set("recipeJson", JSON.stringify(recipe.filter((r) => r.ingredientId && r.quantity > 0)));
    startTransition(async () => {
      const res = await upsertProductAction(fd);
      if (!res.ok) setMessage(res.error);
      else {
        setMessage("Saved");
        startCreate();
      }
    });
  }

  function uploadImage(file: File) {
    if (!editing) return;
    setImageError(null);
    const fd = new FormData();
    fd.set("productId", editing.id);
    fd.set("file", file);
    startImageTransition(async () => {
      const res = await uploadProductImageAction(fd);
      if (!res.ok) {
        setImageError(res.error);
        return;
      }
      setEditing((e) => (e ? { ...e, imageUrl: res.imageUrl } : e));
    });
  }

  function removeImage() {
    if (!editing) return;
    setImageError(null);
    startImageTransition(async () => {
      const res = await removeProductImageAction(editing.id);
      if (!res.ok) {
        setImageError(res.error);
        return;
      }
      setEditing((e) => (e ? { ...e, imageUrl: null } : e));
    });
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_1.2fr]">
      <div className="panel min-w-0 overflow-hidden">
        <div className="catalog-list-header">
          <div><h2 className="font-semibold">Products</h2><p>{products.length} items in your catalog</p></div>
          <button type="button" className="btn-secondary" onClick={startCreate}>
            + New product
          </button>
        </div>
        <div className="catalog-list-search"><input type="search" className="field" aria-label="Search products" placeholder="Search by name or SKU…" value={productSearch} onChange={e => { setProductSearch(e.target.value); setProductPage(1); }} /></div>
        <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th />
              <th>Name</th>
              <th>Price</th>
              <th>Recipe cost</th>
              <th>Active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filteredProducts.slice((currentProductPage - 1) * 30, currentProductPage * 30).map((p) => (
              <tr key={p.id}>
                <td>
                  <ProductThumb name={p.name} imageUrl={p.imageUrl} />
                </td>
                <td>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs" style={{ color: "var(--muted)" }}>
                    {p.sku || "no sku"} · {p.recipeLines.length} ingredients
                  </div>
                </td>
                <td className="num">{formatMoney(p.priceCents)}</td>
                <td className="num">{formatMoney(Math.round(p.theoreticalCostCents))}</td>
                <td>{p.active ? "Yes" : "No"}</td>
                <td>
                  <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => startEdit(p)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <div className="catalog-list-footer"><span>{filteredProducts.length} matching items</span><div><button type="button" className="btn-secondary" disabled={currentProductPage === 1} onClick={() => setProductPage(currentProductPage - 1)}>Previous</button><span>{currentProductPage} / {productPages}</span><button type="button" className="btn-secondary" disabled={currentProductPage === productPages} onClick={() => setProductPage(currentProductPage + 1)}>Next</button></div></div>
      </div>

      <div id="product-editor" className="panel space-y-3 p-5 scroll-mt-20 xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)] xl:self-start xl:overflow-y-auto">
        <h2 className="font-semibold">{editing ? "Edit product" : "New product"}</h2>

        {editing ? (
          <div className="flex items-center gap-3">
            <ProductThumb name={editing.name} imageUrl={editing.imageUrl} size={64} />
            <div className="flex flex-col gap-1">
              <label className="btn-secondary cursor-pointer px-2 py-1 text-xs">
                {imagePending ? "Uploading…" : editing.imageUrl ? "Replace photo" : "Upload photo"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  disabled={imagePending}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadImage(file);
                    e.target.value = "";
                  }}
                />
              </label>
              {editing.imageUrl && (
                <button
                  type="button"
                  className="text-left text-xs"
                  style={{ color: "var(--danger)" }}
                  disabled={imagePending}
                  onClick={removeImage}
                >
                  Remove photo
                </button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Save the product first, then come back to add a photo.
          </p>
        )}
        {imageError && (
          <p className="text-xs" style={{ color: "var(--danger)" }}>
            {imageError}
          </p>
        )}

        <div>
          <label className="label">Name</label>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">SKU</label>
          <input className="field" value={sku} onChange={(e) => setSku(e.target.value)} />
        </div>
        <div>
          <label className="label">Price (PHP) — walk-in / takeout</label>
          <input className="field" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">FoodPanda price</label>
            <input
              className="field"
              placeholder={price || "same as walk-in"}
              value={foodpandaPrice}
              onChange={(e) => setFoodpandaPrice(e.target.value)}
            />
          </div>
          <div>
            <label className="label">GrabFood price</label>
            <input
              className="field"
              placeholder={price || "same as walk-in"}
              value={grabfoodPrice}
              onChange={(e) => setGrabfoodPrice(e.target.value)}
            />
          </div>
        </div>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Leave a platform price blank to charge the walk-in price there too.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active on POS
        </label>

        <div className="space-y-2 border-t pt-3" style={{ borderColor: "var(--line)" }}>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Recipe (BOM)</h3>
            <button
              type="button"
              className="btn-secondary px-2 py-1 text-xs"
              onClick={() =>
                setRecipe((r) => [
                  ...r,
                  { ingredientId: ingredients[0]?.id ?? "", quantity: 1 },
                ])
              }
            >
              Add line
            </button>
          </div>
          {recipe.map((line, idx) => {
            const ing = ingredients.find((i) => i.id === line.ingredientId);
            const unitCost = ing?.costCentsPerUnit ?? 0;
            return (
            <div key={idx} className="flex items-center gap-2">
              <select
                className="field"
                value={line.ingredientId}
                onChange={(e) => {
                  const next = [...recipe];
                  next[idx] = { ...next[idx], ingredientId: e.target.value };
                  setRecipe(next);
                }}
              >
                {ingredients.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.unit})
                  </option>
                ))}
              </select>
              <input
                className="field w-24"
                type="number"
                min="0.0001"
                step="any"
                value={line.quantity}
                onChange={(e) => {
                  const next = [...recipe];
                  next[idx] = { ...next[idx], quantity: Number(e.target.value) };
                  setRecipe(next);
                }}
              />
              <div className="num w-24 shrink-0 text-right text-xs">
                <div>{formatMoney(Math.round(unitCost * line.quantity))}</div>
                <div style={{ color: unitCost === 0 ? "var(--warn)" : "var(--muted)" }}>
                  {unitCost === 0 ? "no cost set" : `${formatMoney(unitCost)}/${ing?.unit ?? ""}`}
                </div>
              </div>
              <button
                type="button"
                className="btn-secondary px-2"
                onClick={() => setRecipe(recipe.filter((_, i) => i !== idx))}
              >
                ×
              </button>
            </div>
            );
          })}
          {editing && editing.sweetnessLines.length > 0 && (
            <div className="rounded-lg border p-2 text-xs" style={{ borderColor: "var(--line)" }}>
              <div className="mb-1 font-semibold">Depends on sweetness (kept as-is when you save)</div>
              {[...new Set(editing.sweetnessLines.map((l) => l.ingredientId))].map((id) => {
                const ing = ingredients.find((i) => i.id === id);
                const levels = editing.sweetnessLines
                  .filter((l) => l.ingredientId === id)
                  .sort((a, b) => b.sweetnessPercent - a.sweetnessPercent);
                return (
                  <div key={id} className="num">
                    {ing?.name ?? "?"}:{" "}
                    {levels
                      .map(
                        (l) =>
                          `${l.quantity} ${ing?.unit ?? ""} at ${l.sweetnessPercent}% (${formatMoney(
                            Math.round((ing?.costCentsPerUnit ?? 0) * l.quantity),
                          )})`,
                      )
                      .join(" · ")}
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Theoretical cost: <span className="num">{formatMoney(Math.round(theoretical))}</span>
            {priceCents > 0 && (
              <>
                {" "}
                · <span className="num">{((theoretical / priceCents) * 100).toFixed(0)}%</span> of price
              </>
            )}
            {editing && editing.sweetnessLines.length > 0 ? " (excludes the sweetness-dependent lines above)" : ""}
          </p>
        </div>

        <button type="button" className="btn-primary w-full" disabled={pending} onClick={save}>
          {pending ? "Saving…" : "Save product"}
        </button>
        {message && <p className="text-sm">{message}</p>}
      </div>
    </div>
  );
}
