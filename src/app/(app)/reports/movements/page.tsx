import { prisma } from "@/lib/prisma";
import { requireManager } from "@/lib/session";
import { getStockMovementLedger } from "@/lib/reports";
import { resolveReportFilters } from "@/lib/reportFilters";
import { ReportsNav } from "@/components/reports-nav";
import { MovementType, Role } from "@prisma/client";

const MOVEMENT_TYPES = Object.values(MovementType);

export default async function MovementsReportPage({
  searchParams,
}: {
  searchParams: Promise<{
    days?: string;
    branchId?: string;
    ingredientId?: string;
    type?: string;
  }>;
}) {
  const user = await requireManager();
  const params = await searchParams;
  const { days, branches, branchId, since, branchIds } = await resolveReportFilters(user, params);

  const ingredients = await prisma.ingredient.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { name: "asc" },
  });

  const type = MOVEMENT_TYPES.includes(params.type as MovementType)
    ? (params.type as MovementType)
    : undefined;

  const movements = await getStockMovementLedger({
    branchIds,
    ingredientId: params.ingredientId || undefined,
    type,
    range: { since },
    limit: 200,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Stock movement ledger</h1>
        <form className="flex flex-wrap gap-2">
          <select name="days" className="field w-auto" defaultValue={String(days)}>
            {[7, 14, 30, 90].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
          <select name="branchId" className="field w-auto" defaultValue={branchId ?? ""}>
            {user.role === Role.OWNER && <option value="">All my branches</option>}
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </select>
          <select name="ingredientId" className="field w-auto" defaultValue={params.ingredientId ?? ""}>
            <option value="">All ingredients</option>
            {ingredients.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
          <select name="type" className="field w-auto" defaultValue={params.type ?? ""}>
            <option value="">All types</option>
            {MOVEMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button type="submit" className="btn-secondary">
            Apply
          </button>
        </form>
      </div>
      <ReportsNav />

      <div className="panel overflow-x-auto p-4">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Branch</th>
              <th>Type</th>
              <th>Ingredient</th>
              <th>Δ</th>
              <th>Balance after</th>
              <th>By</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id}>
                <td className="whitespace-nowrap text-xs">{m.createdAt.toLocaleString()}</td>
                <td>{m.branch.code}</td>
                <td className="text-xs">{m.type}</td>
                <td>{m.ingredient.name}</td>
                <td>{m.quantity.toString()}</td>
                <td>{m.balanceAfter.toString()}</td>
                <td className="text-xs">{m.createdBy?.name ?? "—"}</td>
                <td className="text-xs">{m.note ?? "—"}</td>
              </tr>
            ))}
            {movements.length === 0 && (
              <tr>
                <td colSpan={8} style={{ color: "var(--muted)" }}>
                  No movements match these filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
