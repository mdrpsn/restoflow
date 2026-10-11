import Link from "next/link";
import { requireManager } from "@/lib/session";
import { getRecipeHealth } from "@/lib/reports";
import { ReportsNav } from "@/components/reports-nav";
import { formatMoney } from "@/lib/money";
import { Badge } from "@/components/badge";

export default async function RecipeHealthPage() {
  const user = await requireManager();
  const health = await getRecipeHealth(user.organizationId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Recipe health</h1>
      </div>
      <ReportsNav />

      <p className="text-xs" style={{ color: "var(--muted)" }}>
        A catalog-wide audit, not scoped to a date range: every active product, whether it has a
        recipe, whether that recipe leans on an ingredient with no cost entered, and whether its
        food-cost % looks plausible (flagged above {45}% or below {5}%).
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Active products
          </div>
          <div className="num text-2xl font-semibold">{health.totalActiveProducts}</div>
        </div>
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            With a recipe
          </div>
          <div className="num text-2xl font-semibold">{health.mappedCount}</div>
        </div>
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Coverage
          </div>
          <div className="text-2xl font-semibold">{health.coveragePercent.toFixed(0)}%</div>
        </div>
      </div>

      <div className="panel p-4">
        <h2 className="mb-1 font-semibold">Missing recipes ({health.missingRecipes.length})</h2>
        <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
          These sell with no stock deduction. A cashier can still ring them up; only a manager
          override lets that happen with insufficient stock elsewhere, but a missing recipe skips
          stock deduction entirely and won&apos;t show up as a food-cost line.
        </p>
        {health.missingRecipes.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--accent)" }}>Every active product has a recipe.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th>SKU</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {health.missingRecipes.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.category || "Uncategorized"}</td>
                  <td className="num">{p.sku || "—"}</td>
                  <td>
                    <Link href="/catalog/products" className="btn-secondary px-2 py-1 text-xs">
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel p-4">
        <h2 className="mb-1 font-semibold">Zero-cost ingredients in use ({health.zeroCostIngredients.length})</h2>
        <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
          These ingredients have no cost entered, so every recipe line using them is silently
          costed at ₱0 — the product&apos;s food-cost % is understated.
        </p>
        {health.zeroCostIngredients.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--accent)" }}>No zero-cost ingredient is used in any recipe.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Ingredient</th>
                <th>Unit</th>
                <th>Used in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {health.zeroCostIngredients.map((z) => (
                <tr key={z.ingredientId}>
                  <td>{z.name}</td>
                  <td>{z.unit}</td>
                  <td>
                    {z.productNames.length} product{z.productNames.length === 1 ? "" : "s"}
                    <div className="text-xs" style={{ color: "var(--muted)" }}>
                      {z.productNames.slice(0, 4).join(", ")}
                      {z.productNames.length > 4 ? `, +${z.productNames.length - 4} more` : ""}
                    </div>
                  </td>
                  <td>
                    <Link href="/catalog/ingredients" className="btn-secondary px-2 py-1 text-xs">
                      Set cost
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel p-4">
        <h2 className="mb-1 font-semibold">Food-cost outliers ({health.outliers.length})</h2>
        <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
          Flagged above 45% (recipe is eating too much margin, or a quantity/unit is wrong) or
          below 5% (usually a missing line, not a genuinely cheap product).
        </p>
        {health.outliers.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--accent)" }}>No outliers.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>SKU</th>
                <th>Price</th>
                <th>Theoretical cost</th>
                <th>Food cost %</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {health.outliers.map((o) => (
                <tr key={o.id}>
                  <td>{o.name}</td>
                  <td className="num">{o.sku || "—"}</td>
                  <td className="num">{formatMoney(o.priceCents)}</td>
                  <td className="num">{formatMoney(Math.round(o.costCents))}</td>
                  <td className="num">
                    {o.foodCostPercent.toFixed(0)}%{" "}
                    <Badge tone={o.direction === "high" ? "bad" : "warn"}>
                      {o.direction === "high" ? "high" : "low"}
                    </Badge>
                  </td>
                  <td>
                    <Link href="/catalog/products" className="btn-secondary px-2 py-1 text-xs">
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
