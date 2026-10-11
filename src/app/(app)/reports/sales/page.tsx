import { requireManager } from "@/lib/session";
import { getSalesByDay, getSalesByBranch, getTopProducts, getSalesByChannel, getSalesByCashier } from "@/lib/reports";
import { resolveReportFilters } from "@/lib/reportFilters";
import { ReportFilterBar } from "@/components/report-filter-bar";
import { ReportsNav } from "@/components/reports-nav";
import { formatMoney } from "@/lib/money";

export default async function SalesReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; branchId?: string }>;
}) {
  const user = await requireManager();
  const params = await searchParams;
  const { days, branches, branchId, since, branchIds } = await resolveReportFilters(user, params);

  const [salesByDay, salesByBranch, topProducts, salesByChannel, salesByCashier] = await Promise.all([
    getSalesByDay(branchIds, { since }),
    getSalesByBranch(branchIds, { since }),
    getTopProducts(branchIds, { since }),
    getSalesByChannel(branchIds, { since }),
    getSalesByCashier(branchIds, { since }),
  ]);

  const CHANNEL_LABELS: Record<string, string> = {
    WALK_IN: "Walk-in / Takeout",
    FOODPANDA: "FoodPanda",
    GRABFOOD: "GrabFood",
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Sales</h1>
        <ReportFilterBar days={days} branches={branches} branchId={branchId} role={user.role} />
      </div>
      <ReportsNav />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="panel p-4">
          <h2 className="mb-3 font-semibold">Sales by day</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Tickets</th>
                <th>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {salesByDay.map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  <td className="num">{d.count}</td>
                  <td className="num">{formatMoney(d.cents)}</td>
                </tr>
              ))}
              {salesByDay.length === 0 && (
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
          <h2 className="mb-3 font-semibold">Top products</h2>
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
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="panel p-4">
          <h2 className="mb-3 font-semibold">Sales by channel</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Tickets</th>
                <th>Revenue</th>
                <th>Avg ticket</th>
              </tr>
            </thead>
            <tbody>
              {salesByChannel.map((c) => (
                <tr key={c.channel}>
                  <td>{CHANNEL_LABELS[c.channel] ?? c.channel}</td>
                  <td className="num">{c.count}</td>
                  <td className="num">{formatMoney(c.cents)}</td>
                  <td className="num">{formatMoney(c.avgTicketCents)}</td>
                </tr>
              ))}
              {salesByChannel.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ color: "var(--muted)" }}>
                    No sales in range
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="panel p-4">
          <h2 className="mb-3 font-semibold">Sales by cashier</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Cashier</th>
                <th>Tickets</th>
                <th>Revenue</th>
                <th>By channel</th>
              </tr>
            </thead>
            <tbody>
              {salesByCashier.map((c) => (
                <tr key={c.cashierId}>
                  <td>{c.cashierName}</td>
                  <td className="num">{c.count}</td>
                  <td className="num">{formatMoney(c.cents)}</td>
                  <td className="text-xs" style={{ color: "var(--muted)" }}>
                    {c.channels
                      .map((ch) => `${CHANNEL_LABELS[ch.channel] ?? ch.channel}: ${formatMoney(ch.cents)}`)
                      .join(" · ")}
                  </td>
                </tr>
              ))}
              {salesByCashier.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ color: "var(--muted)" }}>
                    No sales in range
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel p-4">
        <h2 className="mb-3 font-semibold">Branch performance</h2>
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
    </div>
  );
}
