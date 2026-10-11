import { prisma } from "@/lib/prisma";
import { requireManager } from "@/lib/session";
import { getLowStockItems } from "@/lib/stock";
import { resolveReportFilters } from "@/lib/reportFilters";
import { ReportFilterBar } from "@/components/report-filter-bar";
import { ReportsNav } from "@/components/reports-nav";
import { Decimal } from "@prisma/client/runtime/library";

export default async function InventoryReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; branchId?: string }>;
}) {
  const user = await requireManager();
  const params = await searchParams;
  const { days, branches, branchId, branchIds } = await resolveReportFilters(user, params);

  const [stockItems, lowStock] = await Promise.all([
    prisma.stockItem.findMany({
      where: { branchId: { in: branchIds } },
      include: { ingredient: true, branch: true },
      orderBy: [{ branch: { code: "asc" } }, { ingredient: { name: "asc" } }],
    }),
    getLowStockItems(branchIds),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Inventory levels</h1>
        <ReportFilterBar days={days} branches={branches} branchId={branchId} role={user.role} />
      </div>
      <ReportsNav />

      <div className="panel p-4">
        <h2 className="mb-2 font-semibold" style={{ color: "var(--warn)" }}>
          Low stock ({lowStock.length})
        </h2>
        <table className="table">
          <thead>
            <tr>
              <th>Branch</th>
              <th>Ingredient</th>
              <th>On hand</th>
              <th>Threshold</th>
            </tr>
          </thead>
          <tbody>
            {lowStock.map((i) => (
              <tr key={i.id}>
                <td>{i.branch.code}</td>
                <td>{i.ingredient.name}</td>
                <td>{i.quantity.toString()}</td>
                <td>{i.lowStockAt.toString()}</td>
              </tr>
            ))}
            {lowStock.length === 0 && (
              <tr>
                <td colSpan={4} style={{ color: "var(--muted)" }}>
                  None below threshold
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel overflow-x-auto p-4">
        <h2 className="mb-2 font-semibold">All stock on hand</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Branch</th>
              <th>Ingredient</th>
              <th>On hand</th>
              <th>Unit</th>
            </tr>
          </thead>
          <tbody>
            {stockItems.map((s) => (
              <tr key={s.id}>
                <td>{s.branch.code}</td>
                <td>{s.ingredient.name}</td>
                <td>{new Decimal(s.quantity).toString()}</td>
                <td>{s.ingredient.unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
