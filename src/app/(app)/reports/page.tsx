import { requireManager } from "@/lib/session";
import {
  getSalesByDay,
  getSalesByBranch,
  getSalesByCategory,
  getTopProducts,
  getFoodCostSummary,
  getTransferActivity,
} from "@/lib/reports";
import { getStockAlertSummary } from "@/lib/stock";
import { resolveReportFilters } from "@/lib/reportFilters";
import { ReportFilterBar } from "@/components/report-filter-bar";
import { ReportsNav } from "@/components/reports-nav";
import { formatMoney } from "@/lib/money";

export default async function ReportsOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; branchId?: string }>;
}) {
  const user = await requireManager();
  const params = await searchParams;
  const { days, branches, branchId, since, branchIds } = await resolveReportFilters(user, params);

  const [salesByDay, salesByBranch, salesByCategory, topProducts, stockAlerts, foodCost, transferActivity] =
    await Promise.all([
      getSalesByDay(branchIds, { since }),
      getSalesByBranch(branchIds, { since }),
      getSalesByCategory(branchIds, { since }),
      getTopProducts(branchIds, { since }, 10),
      getStockAlertSummary(branchIds),
      getFoodCostSummary(user.organizationId, branchIds, { since }),
      getTransferActivity(user.organizationId, { since }),
    ]);

  const totalCents = salesByDay.reduce((s, d) => s + d.cents, 0);
  const totalTickets = salesByDay.reduce((s, d) => s + d.count, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Last {days} days · {formatMoney(totalCents)} across {totalTickets} sales
          </p>
        </div>
        <ReportFilterBar days={days} branches={branches} branchId={branchId} role={user.role} />
      </div>

      <ReportsNav />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Revenue
          </div>
          <div className="num text-2xl font-semibold">{formatMoney(totalCents)}</div>
        </div>
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Food cost %
          </div>
          <div className="text-2xl font-semibold">
            {foodCost.foodCostPercent === null ? "—" : `${foodCost.foodCostPercent.toFixed(1)}%`}
          </div>
        </div>
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Critical items
          </div>
          <div className="text-2xl font-semibold" style={{ color: stockAlerts.critical.length ? "var(--danger)" : undefined }}>
            {stockAlerts.critical.length}
          </div>
        </div>
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Low stock items
          </div>
          <div className="text-2xl font-semibold" style={{ color: stockAlerts.low.length ? "var(--warn)" : undefined }}>
            {stockAlerts.low.length}
          </div>
        </div>
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Transfers in transit
          </div>
          <div className="text-2xl font-semibold">{transferActivity.openInTransit.length}</div>
        </div>
      </div>

      {stockAlerts.trackedCount === 0 ? (
        <div className="panel p-4" style={{ background: "#fff8f0", borderColor: "#f0d9b5" }}>
          <p className="text-sm">
            <strong>No opening stock counts recorded yet</strong> — the critical/low counts above
            read zero because nothing has been counted in, not because stock is healthy. Enter
            starting quantities from <a href="/inventory" className="underline">Inventory</a> once
            real counts are available.
          </p>
        </div>
      ) : (
        (stockAlerts.critical.length > 0 || stockAlerts.low.length > 0) && (
          <div className="panel p-4" style={{ background: "#fff8f0" }}>
            <h2 className="mb-2 font-semibold">Running low / critical</h2>
            <ul className="space-y-1 text-sm">
              {stockAlerts.critical.map((i) => (
                <li key={i.id}>
                  <span className="font-semibold" style={{ color: "var(--danger)" }}>
                    OUT
                  </span>{" "}
                  {i.ingredient.name} at {i.branch.name}: {String(i.quantity)} {i.ingredient.unit}
                </li>
              ))}
              {stockAlerts.low.map((i) => (
                <li key={i.id}>
                  <span className="font-semibold" style={{ color: "var(--warn)" }}>
                    LOW
                  </span>{" "}
                  {i.ingredient.name} at {i.branch.name}: {String(i.quantity)} {i.ingredient.unit}{" "}
                  (threshold {String(i.lowStockAt)})
                </li>
              ))}
            </ul>
          </div>
        )
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="panel p-4">
          <h2 className="mb-3 font-semibold">Top 10 products by revenue</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Qty</th>
                <th>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {topProducts.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td>
                  <td className="num">{p.qty}</td>
                  <td className="num">{formatMoney(p.cents)}</td>
                </tr>
              ))}
              {topProducts.length === 0 && (
                <tr>
                  <td colSpan={3} style={{ color: "var(--muted)" }}>
                    No sales in range
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="panel p-4">
          <h2 className="mb-3 font-semibold">Sales by category</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Qty</th>
                <th>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {salesByCategory.map((c) => (
                <tr key={c.category}>
                  <td>{c.category}</td>
                  <td className="num">{c.qty}</td>
                  <td className="num">{formatMoney(c.cents)}</td>
                </tr>
              ))}
              {salesByCategory.length === 0 && (
                <tr>
                  <td colSpan={3} style={{ color: "var(--muted)" }}>
                    No sales in range
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel p-4">
        <h2 className="mb-3 font-semibold">Sales by branch</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Branch</th>
              <th>Tickets</th>
              <th>Revenue</th>
              <th>Avg ticket</th>
            </tr>
          </thead>
          <tbody>
            {salesByBranch.map((b) => (
              <tr key={b.branchId}>
                <td>
                  {b.branchCode} — {b.branchName}
                </td>
                <td className="num">{b.count}</td>
                <td className="num">{formatMoney(b.cents)}</td>
                <td className="num">{formatMoney(b.avgTicketCents)}</td>
              </tr>
            ))}
            {salesByBranch.length === 0 && (
              <tr>
                <td colSpan={4} style={{ color: "var(--muted)" }}>
                  No sales in range
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-sm" style={{ color: "var(--muted)" }}>
        Use the tabs above for the full sales, inventory, consumption/variance, food cost,
        movement ledger, and transfer activity detail behind this overview.
      </p>
    </div>
  );
}
