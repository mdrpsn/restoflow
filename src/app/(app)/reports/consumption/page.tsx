import { requireManager } from "@/lib/session";
import { getIngredientConsumption, getVarianceReport } from "@/lib/reports";
import { resolveReportFilters } from "@/lib/reportFilters";
import { ReportFilterBar } from "@/components/report-filter-bar";
import { ReportsNav } from "@/components/reports-nav";

export default async function ConsumptionReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; branchId?: string }>;
}) {
  const user = await requireManager();
  const params = await searchParams;
  const { days, branches, branchId, since, branchIds } = await resolveReportFilters(user, params);

  const [consumption, variance] = await Promise.all([
    getIngredientConsumption(branchIds, { since }),
    getVarianceReport(branchIds, { since }),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Consumption &amp; variance</h1>
        <ReportFilterBar days={days} branches={branches} branchId={branchId} role={user.role} />
      </div>
      <ReportsNav />

      <div className="panel p-4">
        <h2 className="mb-2 font-semibold">Theoretical ingredient consumption</h2>
        <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
          What the recipes say should have been used, based on completed sales in range.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Ingredient</th>
              <th>Consumed</th>
              <th>Unit</th>
            </tr>
          </thead>
          <tbody>
            {consumption.map((c) => (
              <tr key={c.ingredientId}>
                <td>{c.name}</td>
                <td>{c.consumedQty}</td>
                <td>{c.unit}</td>
              </tr>
            ))}
            {consumption.length === 0 && (
              <tr>
                <td colSpan={3} style={{ color: "var(--muted)" }}>
                  No sales-driven consumption in range
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel p-4">
        <h2 className="mb-2 font-semibold">Actual vs. theoretical (variance)</h2>
        <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
          Theoretical consumption vs. what physical counts (net adjustments) and logged waste
          show actually happened. A negative net adjustment means counts found less on hand than
          the ledger expected — unexplained shrinkage beyond logged waste.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Ingredient</th>
              <th>Theoretical use</th>
              <th>Waste logged</th>
              <th>Net adjustments</th>
            </tr>
          </thead>
          <tbody>
            {variance.map((v) => (
              <tr key={v.ingredientId}>
                <td>{v.name}</td>
                <td>
                  {v.theoreticalConsumption} {v.unit}
                </td>
                <td>
                  {v.wasteQty} {v.unit}
                </td>
                <td
                  style={
                    Number(v.adjustmentNet) < 0 ? { color: "var(--danger)" } : undefined
                  }
                >
                  {v.adjustmentNet} {v.unit}
                </td>
              </tr>
            ))}
            {variance.length === 0 && (
              <tr>
                <td colSpan={4} style={{ color: "var(--muted)" }}>
                  No relevant movements in range
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
