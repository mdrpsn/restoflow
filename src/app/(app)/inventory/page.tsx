import { prisma } from "@/lib/prisma";
import { requireWarehouseAdmin } from "@/lib/session";
import { requireActiveBranch } from "@/lib/branch";
import { getLowStockItems } from "@/lib/stock";
import { adjustStockAction, logWasteAction, setLowStockAction } from "@/actions";
import { Decimal } from "@prisma/client/runtime/library";
import { ReceiveStockForm } from "@/components/receive-stock-form";
import { formatQty, formatStock } from "@/lib/packs";
import Link from "next/link";
import { InventoryBrowser } from "@/components/inventory-browser";

async function adjustStockFormAction(formData: FormData) {
  "use server";
  await adjustStockAction(formData);
}

async function setLowStockFormAction(formData: FormData) {
  "use server";
  await setLowStockAction(formData);
}

async function logWasteFormAction(formData: FormData) {
  "use server";
  await logWasteAction(formData);
}

export default async function InventoryPage() {
  const user = await requireWarehouseAdmin();
  const branch = await requireActiveBranch(user);

  const [ingredients, stockItems, lowStock] = await Promise.all([
    prisma.ingredient.findMany({
      where: { organizationId: user.organizationId },
      include: { packs: { orderBy: { size: "asc" } } },
      orderBy: { name: "asc" },
    }),
    prisma.stockItem.findMany({
      where: { branchId: branch.id },
      include: { ingredient: true },
      orderBy: { ingredient: { name: "asc" } },
    }),
    getLowStockItems([branch.id]),
  ]);

  const stockByIngredient = new Map(stockItems.map((s) => [s.ingredientId, s]));
  // Only the warehouse thinks in packs; branches open and cut them, so they see the base unit.
  const showPacks = branch.type === "WAREHOUSE";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Levels for <strong>{branch.name}</strong>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/inventory/import" className="btn-secondary">
            Import count sheet →
          </Link>
          <Link href="/inventory/cycle-count" className="btn-secondary">
            Cycle count →
          </Link>
          <Link href="/transfers" className="btn-secondary">
            Stock transfers →
          </Link>
        </div>
      </div>

      {lowStock.length > 0 && <details className="panel stock-alert">
        <summary><span className="stock-alert-icon">!</span><span><strong>{lowStock.length} items need attention</strong><small>Stock is at or below its alert level. Open to review the list.</small></span><span className="stock-alert-chevron">⌄</span></summary>
        <ul>{lowStock.map(i => <li key={i.id}><strong>{i.ingredient.name}</strong><span>{formatQty(Number(i.quantity), i.ingredient.unit)} on hand · alert at {String(i.lowStockAt)}</span></li>)}</ul>
      </details>}

      <InventoryBrowser rows={ingredients.map(ing => {
        const stock = stockByIngredient.get(ing.id);
        const qty = stock ? new Decimal(stock.quantity) : new Decimal(0);
        const low = stock ? new Decimal(stock.lowStockAt) : new Decimal(0);
        const isLow = lowStock.some(item => item.ingredientId === ing.id);
        return {
          id: ing.id, name: ing.name,
          onHand: formatStock(qty.toNumber(), ing.unit, ing.packs.map(p => ({ name: p.name, size: Number(p.size) })), showPacks),
          lowAt: low.toString(), parLevel: stock?.parLevel?.toString() ?? "—", unit: ing.unit,
          isLow,
          status: isLow ? "Low stock" : !stock ? "Not counted" : qty.isZero() ? "Zero on hand" : "In stock",
        };
      })} />

      <div className="grid gap-4 lg:grid-cols-3">
        <ReceiveStockForm
          ingredients={ingredients.map((i) => ({
            id: i.id,
            name: i.name,
            unit: i.unit,
            packs: i.packs.map((p) => ({ id: p.id, name: p.name, size: Number(p.size), isDefault: p.isDefault })),
          }))}
        />

        <form action={logWasteFormAction} className="panel space-y-3 p-4">
          <h2 className="font-semibold">Log waste</h2>
          <div>
            <label className="label">Ingredient</label>
            <select name="ingredientId" className="field" required>
              {ingredients.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Quantity</label>
            <input name="quantity" className="field" required type="number" step="any" min="0.0001" />
          </div>
          <div>
            <label className="label">Reason</label>
            <input name="reason" className="field" required placeholder="Dropped, expired, spilled…" />
          </div>
          <button type="submit" className="btn-secondary w-full">
            Log waste
          </button>
        </form>

        <div className="space-y-4">
          <form action={adjustStockFormAction} className="panel space-y-3 p-4">
            <h2 className="font-semibold">Set quantity</h2>
            <div>
              <label className="label">Ingredient</label>
              <select name="ingredientId" className="field" required>
                {ingredients.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">New quantity</label>
              <input name="quantity" className="field" required type="number" step="any" min="0" />
            </div>
            <div>
              <label className="label">Note</label>
              <input name="note" className="field" />
            </div>
            <button type="submit" className="btn-secondary w-full">
              Adjust
            </button>
          </form>

          <form action={setLowStockFormAction} className="panel space-y-3 p-4">
            <h2 className="font-semibold">Low-stock threshold</h2>
            <div>
              <label className="label">Ingredient</label>
              <select name="ingredientId" className="field" required>
                {ingredients.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Alert when ≤</label>
              <input name="lowStockAt" className="field" required type="number" step="any" min="0" />
            </div>
            <div>
              <label className="label">Replenish to par level (optional)</label>
              <input name="parLevel" className="field" type="number" step="any" min="0" />
              <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                Must be at or above the alert threshold. Leave blank for alert-only tracking.
              </p>
            </div>
            <button type="submit" className="btn-secondary w-full">
              Save stock policy
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
