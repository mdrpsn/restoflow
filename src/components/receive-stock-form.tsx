"use client";

import { useState, useTransition } from "react";
import { receiveStockAction } from "@/actions";
import { formatNumber, formatQty, packToBase } from "@/lib/packs";

type Pack = { id: string; name: string; size: number; isDefault: boolean };
type Ingredient = { id: string; name: string; unit: string; packs: Pack[] };

export function ReceiveStockForm({ ingredients }: { ingredients: Ingredient[] }) {
  const [ingredientId, setIngredientId] = useState(ingredients[0]?.id ?? "");
  const ing = ingredients.find((i) => i.id === ingredientId);
  const [packId, setPackId] = useState(ing?.packs.find((p) => p.isDefault)?.id ?? "");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const pack = ing?.packs.find((p) => p.id === packId);
  const qtyNum = Number(quantity);

  function pickIngredient(id: string) {
    setIngredientId(id);
    setPackId(ingredients.find((i) => i.id === id)?.packs.find((p) => p.isDefault)?.id ?? "");
  }

  function submit() {
    setMessage(null);
    const fd = new FormData();
    fd.set("ingredientId", ingredientId);
    fd.set("quantity", quantity);
    fd.set("packId", packId);
    fd.set("note", note);
    startTransition(async () => {
      const res = await receiveStockAction(fd);
      if (res.ok) {
        setQuantity("");
        setNote("");
      }
      setMessage(res.ok ? "Stock received" : res.error);
    });
  }

  return (
    <div className="panel space-y-3 p-4">
      <h2 className="font-semibold">Receive stock</h2>
      <div>
        <label className="label">Ingredient</label>
        <select className="field" value={ingredientId} onChange={(e) => pickIngredient(e.target.value)}>
          {ingredients.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Quantity</label>
          <input
            className="field"
            type="number"
            step="any"
            min="0.0001"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Unit</label>
          <select className="field" value={packId} onChange={(e) => setPackId(e.target.value)}>
            <option value="">{ing ? `${ing.unit} (base unit)` : "unit"}</option>
            {ing?.packs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {pack && qtyNum > 0 && (
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          {formatNumber(qtyNum)} × {pack.name} = {formatQty(packToBase(qtyNum, pack), ing!.unit)} will be added
        </p>
      )}
      <div>
        <label className="label">Note</label>
        <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <button type="button" className="btn-primary w-full" disabled={pending || !(qtyNum > 0)} onClick={submit}>
        Receive
      </button>
      {message && <p className="text-sm">{message}</p>}
    </div>
  );
}
